// Autopilot's watcher (docs/designs/pr-autopilot.md): for each session with Autopilot on, it runs the one
// step (shared/autopilot.ts) after any change of the sessions, the PR store or the choices, and every
// LOOK_EVERY_MS for the time limits, one look at a time, and carries out what the step says: a round is a
// message to the session's own agent as a turn (the same message the "needs you" cards' buttons send), a
// merge is the Merge dialog's merge, a stop says why in the session. It reads only the store's held answers.
import type { SessionView } from '../model.ts';
import { autopilotStep, autopilotText, isOn, isWanted, newRecord, offeredRequest, type AutopilotAct, type AutopilotPrefs, type AutopilotRecord } from '../shared/autopilot.ts';
import type { PullRequest, PullRequestLookup } from '../shared/details.ts';
import { isIdle, type AttentionPrefs } from '../shared/request-attention.ts';
import type { Sourced } from '../shared/sourced.ts';
import { Refused } from '../refused.ts';

/** How often it looks even when nothing changed: the time limits and the waits are measured on this. */
export const LOOK_EVERY_MS = 30_000;
/** A look runs this long after a change, so a burst of writes is one look. */
export const AUTOPILOT_LOOK_MS = 300;

export const USER_TOOK_OVER = 'You sent a message, so it is yours again';

export type AutopilotSession = Pick<SessionView, 'id' | 'state' | 'note' | 'title'> & Partial<Pick<SessionView, 'stopped' | 'hostId' | 'autopilot' | 'worktreePath' | 'request'>>;

export interface AutopilotDeps {
  sessions(): Promise<readonly AutopilotSession[]>;
  lookup(sessionId: string): Sourced<PullRequestLookup> | undefined;
  attention(): Promise<AttentionPrefs>;
  prefs(): Promise<AutopilotPrefs>;
  save(sessionId: string, record: AutopilotRecord | null): Promise<void>;
  /** Sends the session a message as a turn (queued behind one that runs). */
  send(sessionId: string, text: string): Promise<unknown>;
  merge(sessionId: string, pr: PullRequest): Promise<void>;
  /** A line in the session's conversation. */
  notice(sessionId: string, text: string, tone: 'info' | 'warning'): void;
  /** Whether a commit is one this session's worktree has (made here); false when a person pushed it. */
  madeHere(session: AutopilotSession, sha: string): Promise<boolean>;
  onChange(listener: () => void): () => void;
  now?: () => number;
  lookMs?: number;
  everyMs?: number;
  log?: (line: string) => void;
}

export class Autopilot {
  private timer: NodeJS.Timeout | null = null;
  private readonly every: NodeJS.Timeout;
  private running: Promise<void> | null = null;
  private again = false;
  private readonly off: () => void;
  /** Sessions with it on at the last look, for the PR store's background pace. */
  private on = new Set<string>();
  /** Sessions waiting for their request to be opened: the PR store keeps looking for it. */
  private armed = new Set<string>();
  /** Merges asked for, by session and commit: never twice while the store has not seen it merged yet. */
  private readonly merging = new Set<string>();

  constructor(private readonly deps: AutopilotDeps) {
    this.off = deps.onChange(() => this.soon());
    this.every = setInterval(() => {
      if (this.anyOn()) void this.look();
    }, deps.everyMs ?? LOOK_EVERY_MS);
    this.every.unref?.();
    // After a restart: find the sessions that had it on.
    this.soon();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Whether any session has it on: the PR store keeps asking hosts then, with no window open. */
  anyOn(): boolean {
    return this.on.size > 0 || this.armed.size > 0;
  }

  isOn(sessionId: string): boolean {
    return this.on.has(sessionId);
  }

  private async session(sessionId: string): Promise<AutopilotSession> {
    const session = (await this.deps.sessions()).find((s) => s.id === sessionId);
    if (!session) throw new Refused('That session is no longer in Kestrel.');
    if (session.hostId) throw new Refused('A guest works on its host\'s pull request: turn Autopilot on in the host session.');
    return session;
  }

  /**
   * Turn it on for the session's open request, with or without Merge when green. `number` is the request
   * the caller knows of (the card's, a link just made) for when the PR store has not answered yet.
   * Refused with the reason when there is none.
   */
  async turnOn(sessionId: string, merge: boolean, number?: number): Promise<AutopilotRecord> {
    const session = await this.session(sessionId);
    const lookup = this.deps.lookup(sessionId);
    const pr = offeredRequest(lookup);
    const known = pr?.number ?? number;
    if (known === undefined) return this.arm(session.id, merge);
    const record = { ...newRecord(known, merge, await this.deps.prefs()), ...(pr?.headSha ? { head: { sha: pr.headSha, at: this.now() } } : {}) };
    await this.deps.save(session.id, record);
    this.on.add(session.id);
    this.armed.delete(session.id);
    this.deps.notice(session.id, `Autopilot is on: ${autopilotText(record).replace(/^On: |^On, /, '')}. Send a message to take over.`, 'info');
    this.soon();
    return record;
  }

  /** On before the session has an open request: it starts on the first one opened (`look`, or `turnOn` from the link). */
  private async arm(sessionId: string, merge: boolean): Promise<AutopilotRecord> {
    const record: AutopilotRecord = { ...newRecord(0, merge, await this.deps.prefs()), waiting: true };
    await this.deps.save(sessionId, record);
    this.armed.add(sessionId);
    this.deps.notice(sessionId, 'Autopilot is on: it starts looking after this session’s pull request once one is opened.', 'info');
    return record;
  }

  /** Whether the session waits for its request to be opened. */
  isArmed(sessionId: string): boolean {
    return this.armed.has(sessionId);
  }

  /** Change Merge when green while it is on or waiting. */
  async setMerge(sessionId: string, merge: boolean): Promise<AutopilotRecord> {
    const session = await this.session(sessionId);
    const record = session.autopilot;
    if (!isWanted(record)) throw new Refused('Autopilot is off for this session.');
    const next = { ...record, merge };
    await this.deps.save(session.id, next);
    this.soon();
    return next;
  }

  /** Turn it off: by the user's hand (no notice to them beyond the line), or because they took over. */
  async turnOff(sessionId: string, why = 'Turned off'): Promise<void> {
    const session = (await this.deps.sessions()).find((s) => s.id === sessionId);
    if (!session || !isWanted(session.autopilot)) return;
    const { round: _round, ...rest } = session.autopilot;
    await this.deps.save(sessionId, { ...rest, stopped: { at: this.now(), why, notify: false } });
    this.on.delete(sessionId);
    this.armed.delete(sessionId);
    this.deps.notice(sessionId, `Autopilot is off: ${why}.`, 'info');
  }

  /** The user sent a message in the session: it is theirs again. */
  userSpoke(sessionId: string): Promise<void> {
    return this.on.has(sessionId) ? this.turnOff(sessionId, USER_TOOK_OVER) : Promise.resolve();
  }

  /** Look now (tests), and wait for it. */
  look(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.lookOnce().catch((error: unknown) => (this.deps.log ?? console.error)(`[kestrel] the Autopilot look failed: ${error instanceof Error ? error.message : String(error)}`));
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  stop(): void {
    this.off();
    clearInterval(this.every);
    if (this.timer) clearTimeout(this.timer);
  }

  private soon(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.look();
    }, this.deps.lookMs ?? AUTOPILOT_LOOK_MS);
    this.timer.unref?.();
  }

  private async lookOnce(): Promise<void> {
    const sessions = await this.deps.sessions();
    const waiting = sessions.filter((s) => !s.hostId && isWanted(s.autopilot) && s.autopilot.waiting);
    this.armed = new Set(waiting.map((s) => s.id));
    // A request opened for a session waiting on one: it starts there.
    for (const session of waiting) {
      const pr = offeredRequest(this.deps.lookup(session.id));
      if (pr) await this.turnOn(session.id, session.autopilot!.merge, pr.number);
    }
    const on = sessions.filter((s) => !s.hostId && isOn(s.autopilot));
    this.on = new Set(on.map((s) => s.id));
    if (on.length === 0) return;
    const attention = await this.deps.attention();
    for (const session of on) {
      const record = session.autopilot!;
      const lookup = this.deps.lookup(session.id);
      const head = lookup?.state === 'ready' ? lookup.value.pullRequests.find((p) => p.number === record.number)?.headSha : undefined;
      const foreignPush = !record.round && !!head && record.head?.sha !== head ? !(await this.deps.madeHere(session, head)) : false;
      const step = autopilotStep({ record, lookup, attention, idle: isIdle(session), failed: session.state === 'interrupted' || session.stopped === true, foreignPush, now: this.now() });
      if (step.record !== record) await this.deps.save(session.id, step.record);
      await this.act(session, step.act, step.record);
    }
  }

  private async act(session: AutopilotSession, act: AutopilotAct, record: AutopilotRecord): Promise<void> {
    if (act.type === 'none') return;
    if (act.type === 'round') {
      await this.deps.send(session.id, act.message);
      return;
    }
    if (act.type === 'green') return this.deps.notice(session.id, `Autopilot: ${act.line}. Merge it yourself, or tick Merge when green.`, 'info');
    if (act.type === 'stop') {
      this.on.delete(session.id);
      if (act.stop.notify) this.deps.notice(session.id, `${act.stop.why}. It is yours again.`, 'warning');
      return;
    }
    const key = `${session.id}\n${act.pr.headSha ?? act.pr.number}`;
    if (this.merging.has(key)) return;
    this.merging.add(key);
    try {
      await this.deps.merge(session.id, act.pr);
      this.deps.notice(session.id, `Autopilot merged #${act.pr.number}.`, 'info');
    } catch (error) {
      this.merging.delete(key);
      const why = `Autopilot could not merge #${act.pr.number}: ${error instanceof Error ? error.message : String(error)}`;
      const { round: _round, ...rest } = record;
      await this.deps.save(session.id, { ...rest, stopped: { at: this.now(), why, notify: true } });
      this.on.delete(session.id);
      this.deps.notice(session.id, `${why}. It is yours again.`, 'warning');
    }
  }
}
