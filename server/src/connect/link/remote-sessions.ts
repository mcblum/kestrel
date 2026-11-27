// Conversations that run on another computer of the account, read from that computer while it can be reached
// (account-sessions.md, section 9.2: "replica, then `session.watch` on a channel when the machine is up").
// Everything is asked through the closed list the other computer's dispatcher already carries out
// (`session.read`, `session.watch`, `session.unwatch`); nothing is added to it.
//
// - Its live output reaches only the window's per-session live channel, never the workspace state: `onLive`.
// - A push is believed only for a session this computer watches on the computer that sent it.
// - What is watched is asked again whenever a channel to that computer opens, so a renewed link or a
//   restarted computer carries on without a timer.
import type { LivePatch } from '../../model.ts';
import type { PullRequestLookup } from '../../shared/details.ts';
import type { Sourced } from '../../shared/sourced.ts';
import type { ConnectOp } from '../../shared/connect-ops.ts';
import type { PageAsk } from '../../shared/transcript-page.ts';
import { asRemotePage, asRemotePatch, type RemotePage } from '../../shared/machines.ts';
import { CALL_TIMEOUT_MS, CallFailed, CallTimedOut, DeskCaller, type CallerDeps } from './caller.ts';

/** What another computer said to `session.read`: a page, its refusal, or that it could not be reached. */
export type RemoteRead = { ok: true; page: RemotePage } | { ok: false; reached: boolean; reason: string };

/**
 * What another computer said to a request: its answer, its refusal (`reached`), or that it could not be reached.
 * `late`: the request went to it and no answer came in time, so it may still have been carried out there.
 */
export type RemoteAnswer = { ok: true; result: unknown } | { ok: false; reached: boolean; reason: string; late?: true };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * How long a read of a conversation waits for its answer. Longer than a call's own (5 s): nothing waits on it (the
 * page shows the account's copy meanwhile, remote-conversation.ts), and a computer busy with a turn may answer late.
 */
export const READ_TIMEOUT_MS = 15_000;

/** Another computer's pull-request lookups, by session id, as its `pullRequests.read` answers them. */
export type RemotePullRequests = Record<string, Sourced<PullRequestLookup>>;

/** The lookups of a `pullRequests.read` answer, or of its push; anything that is not one is left out. */
export function asRemotePullRequests(raw: unknown): RemotePullRequests | null {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).pullRequests : null;
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return null;
  return Object.fromEntries(Object.entries(r as Record<string, unknown>).filter(([, v]) => typeof v === 'object' && v !== null && typeof (v as { state?: unknown }).state === 'string')) as RemotePullRequests;
}

export class RemoteSessions {
  /** Session id -> the computer it is watched on. */
  private readonly watched = new Map<string, string>();
  private readonly listeners = new Set<(sessionId: string, patch: LivePatch) => void>();
  /** The computers whose pull requests were read since their channel opened: each sends them again when they change. */
  private readonly readingRequests = new Set<string>();
  private readonly requestListeners = new Set<(machine: string, lookups: RemotePullRequests) => void>();

  constructor(
    private readonly caller: Pick<DeskCaller, 'request'>,
    private readonly readTimeoutMs = READ_TIMEOUT_MS,
  ) {}

  /**
   * One request of the closed list to the computer that runs a session, as its own window's route would make it
   * there (issue 47): its answer, its refusal with the reason, or that it could not be reached.
   */
  async ask(machine: string, op: ConnectOp, args: Record<string, unknown>, opts: { timeoutMs?: number; fresh?: boolean } = {}): Promise<RemoteAnswer> {
    try {
      const answer = await this.caller.request(machine, op, args, opts);
      return answer.ok ? answer : { ok: false, reached: true, reason: answer.reason };
    } catch (error) {
      if (error instanceof CallTimedOut) return { ok: false, reached: false, reason: error.message, late: true };
      if (error instanceof CallFailed) return { ok: false, reached: false, reason: error.message };
      throw error;
    }
  }

  /** One page of a session's conversation, from the computer that runs it. `fresh`: the person asked again. */
  async read(machine: string, sessionId: string, page: PageAsk, opts: { fresh?: boolean; timeoutMs?: number } = {}): Promise<RemoteRead> {
    const answer = await this.ask(machine, 'session.read', { sessionId, ...page }, { timeoutMs: opts.timeoutMs ?? this.readTimeoutMs, ...(opts.fresh ? { fresh: true } : {}) });
    if (!answer.ok) return answer;
    const found = asRemotePage(answer.result);
    return found ? { ok: true, page: found } : { ok: false, reached: true, reason: 'That computer answered with something that is not a conversation.' };
  }

  /**
   * What a window showing a session there starts from beside its conversation (`session.snapshot`: files, the model and
   * mode, queue, commands), handed to the live listeners as a patch. Asked once when a window opens it; nothing waits
   * for it, and a computer that cannot be reached leaves the page saying so.
   */
  async snapshot(machine: string, sessionId: string): Promise<RemoteAnswer> {
    const answer = await this.ask(machine, 'session.snapshot', { sessionId });
    if (!answer.ok) return answer;
    const patch = asRemotePatch(answer.result);
    if (patch) for (const listener of this.listeners) listener(sessionId, patch);
    return answer;
  }

  /**
   * That computer's pull requests, read once per channel (`pullRequests.read`): it sends them again whenever they
   * change, as it does for a phone that read them, so they are never asked on a timer.
   */
  async readPullRequests(machine: string): Promise<void> {
    if (this.readingRequests.has(machine)) return;
    this.readingRequests.add(machine);
    const answer = await this.ask(machine, 'pullRequests.read', {});
    const lookups = answer.ok ? asRemotePullRequests(answer.result) : null;
    if (!lookups) {
      this.readingRequests.delete(machine);
      return;
    }
    for (const listener of this.requestListeners) listener(machine, lookups);
  }

  onPullRequests(listener: (machine: string, lookups: RemotePullRequests) => void): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  /** A window opened a session that runs there: its live output is asked for while the computer can be reached. */
  watch(machine: string, sessionId: string): void {
    this.watched.set(sessionId, machine);
    this.tell(machine, sessionId, 'session.watch');
  }

  /** The last window stopped watching it. */
  unwatch(sessionId: string): void {
    const machine = this.watched.get(sessionId);
    if (!machine) return;
    this.watched.delete(sessionId);
    this.tell(machine, sessionId, 'session.unwatch');
  }

  watching(sessionId: string): boolean {
    return this.watched.has(sessionId);
  }

  onLive(listener: (sessionId: string, patch: LivePatch) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A push from a computer this one called. */
  push(from: string, body: unknown): void {
    const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    // Its pull requests again, believed only from a computer whose requests this one read.
    if (b.type === 'pull-requests' && this.readingRequests.has(from)) {
      const lookups = asRemotePullRequests(b.pullRequests);
      if (lookups) for (const listener of this.requestListeners) listener(from, lookups);
      return;
    }
    if (b.type !== 'live' || typeof b.sessionId !== 'string' || this.watched.get(b.sessionId) !== from) return;
    const patch = asRemotePatch(b.patch);
    if (!patch) return;
    for (const listener of this.listeners) listener(b.sessionId, patch);
  }

  /** A channel to a computer opened: a new channel watches nothing there, so what is watched is asked again. */
  opened(machine: string): void {
    for (const [sessionId, on] of this.watched) if (on === machine) this.tell(machine, sessionId, 'session.watch');
    // A new channel has read nothing there yet: its pull requests are read again, so they are sent again as they change.
    if (this.readingRequests.delete(machine)) void this.readPullRequests(machine);
  }

  /** A computer asked for a new channel: opened again at once when something there is watched. */
  renewed(machine: string): void {
    const first = [...this.watched].find(([, on]) => on === machine);
    if (first) this.tell(machine, first[0], 'session.watch');
  }

  /** The link came back: each computer something is watched on is called again. */
  linkBack(): void {
    for (const machine of new Set(this.watched.values())) this.renewed(machine);
  }

  private tell(machine: string, sessionId: string, op: 'session.watch' | 'session.unwatch'): void {
    this.caller.request(machine, op, { sessionId }).then(
      (answer) => {
        if (!answer.ok) console.error(`[kestrel] another computer refused ${op}: ${answer.reason}`);
      },
      (error: unknown) => {
        // Not reached: the page says so, and the next channel to it asks again.
        if (!(error instanceof CallFailed)) console.error(`[kestrel] could not ask another computer for ${op}: ${message(error)}`);
      },
    );
  }
}

/** The caller and the remote sessions it serves, wired to each other. */
export function remoteCalls(deps: Omit<CallerDeps, 'push' | 'opened' | 'renewed'>): { caller: DeskCaller; remote: RemoteSessions } {
  let remote: RemoteSessions | null = null;
  const caller = new DeskCaller({ ...deps, push: (from, body) => remote?.push(from, body), opened: (id) => remote?.opened(id), renewed: (id) => remote?.renewed(id) });
  // A caller set to answer quicker (tests) reads quicker too, in the same proportion.
  remote = new RemoteSessions(caller, deps.timeoutMs ? deps.timeoutMs * (READ_TIMEOUT_MS / CALL_TIMEOUT_MS) : READ_TIMEOUT_MS);
  return { caller, remote };
}
