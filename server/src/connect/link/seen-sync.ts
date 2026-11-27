// What was seen across the account's computers, the desk's side (docs/designs/account-sessions.md, "What was
// seen, as built"; shared/account-seen.ts has the record and the merge). This computer holds one sealed record,
// the marks made on it, in the list `seen`; it reads every other computer's into its `SeenStore`, which merges
// them for the windows.
//
// - Writing never blocks a mark: a mark only schedules a pass, which runs after `settleMs`, so a burst of marks
//   is one write. With the link down the pass does nothing, and the next pass after it comes back sends the record.
// - Reading runs when the link comes up, when the service says `changed`, and when the account's devices change,
//   as the heads' reader does, and before each read of the heads, so a session arrives already seen.
// - Only a computer in the keyring this one accepted counts, only under the record id its own id makes, and only
//   as the writer the service names. Opening it at all proves the key.
// - Marks of a project kept off Kestrel Connect are never sent; nor are marks of sessions that are nowhere now.
import type { SessionView } from '../../model.ts';
import type { SeenStore } from '../../seen.ts';
import { asSeenRecord, SEEN_LIST, seenLabel, seenRecordOf, type SeenMarks } from '../../shared/account-seen.ts';
import type { Machine } from '../../shared/machines.ts';
import { projectOfSession } from '../../shared/project-groups.ts';
import type { Workspace } from '../../workspace.ts';
import { openRecord, sealRecord, tagOf } from '../account-key.ts';
import type { ReadyKey } from './account-keys.ts';
import type { HeldApi } from './held-api.ts';
import { NO_PROJECT, SETTLE_MS } from './held.ts';
import { WHOLE_AFTER_MS } from './replica-sync.ts';
import { ServiceRefusal } from './service.ts';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What of the workspace this reads, so a test can stand in for it. */
export interface SeenSource {
  store: Pick<SeenStore, 'ownMarks' | 'prune' | 'takeAccount' | 'forgetAccount' | 'onOwnChange'>;
  /** This computer's sessions (not archived), the ids of its archived ones, and the ids of the sessions the account's other computers run. */
  sessions(): Promise<{ local: readonly SessionView[]; archived: readonly string[]; remote: readonly string[] }>;
}

export function seenSource(workspace: Workspace): SeenSource {
  return {
    store: workspace.seen,
    async sessions() {
      const [state, heads] = await Promise.all([workspace.state(), workspace.account.heads()]);
      return { local: state.sessions, archived: state.archived.sessions.map((s) => s.id), remote: heads.map((h) => h.id) };
    },
  };
}

export interface SeenSyncDeps {
  source: SeenSource;
  /** The service, when the link is up; null otherwise. */
  api(): HeldApi | null;
  key(): ReadyKey | null;
  keyFor(generation: number): Buffer;
  desk(): Machine | null;
  /** The account's other computers that are in the keyring this computer accepted. */
  machines(): Machine[];
  /** Project ids kept off Kestrel Connect; `none` for sessions with no project. */
  keptOff(): readonly string[];
  /** Whether the other computers' sessions have been read in this run; until then none of their marks is dropped. */
  headsRead(): boolean;
  now?(): number;
  settleMs?: number;
}

/** Which of this computer's marks may be sent, and which sessions exist at all. Pure. */
export function seenScope(sessions: Awaited<ReturnType<SeenSource['sessions']>>, keptOff: readonly string[]): { shared: Set<string>; known: Set<string> } {
  const off = new Set(keptOff);
  // A sidebar is listed nowhere but at the desk, and an archived session is not on the account: neither is sent.
  const local = sessions.local.filter((s) => !s.aside && !off.has(projectOfSession(s) ?? NO_PROJECT)).map((s) => s.id);
  const shared = new Set([...local, ...sessions.remote]);
  return { shared, known: new Set([...sessions.local.map((s) => s.id), ...sessions.archived, ...sessions.remote]) };
}

export class SeenSync {
  private running: Promise<void> | null = null;
  private again = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** What was last sent, by scope: sent again only when it differs. */
  private sent: { scope: string; json: string } | null = null;
  /** Where the feed was read up to, in this run only: the first pass reads every record. */
  private mark: { scope: string; seq: number; at: number; members: string[] } | null = null;
  /** A service from before the change feed refuses a listed record: not tried again this run. */
  private refused = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: SeenSyncDeps) {
    // Cheap on purpose: a mark only schedules the pass.
    this.unsubscribe = deps.source.store.onOwnChange(() => this.schedule());
  }

  /** Reads and writes now: the link came up, the service said something changed, the account's devices changed. */
  kick(): void {
    if (this.closed) return;
    void this.run();
  }

  private schedule(): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.kick();
    }, this.deps.settleMs ?? SETTLE_MS);
    this.timer.unref?.();
  }

  /** One pass, one at a time; a pass asked for during one runs after it. */
  run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.pass()
      .catch((error: unknown) => console.error(`[kestrel] could not share what was seen with the account: ${message(error)}`))
      .finally(() => {
        this.running = null;
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
    return this.running;
  }

  /** Resolves when the pass under way (and one asked for meanwhile) is done. */
  async settled(): Promise<void> {
    while (this.running) await this.running;
  }

  private async pass(): Promise<void> {
    if (this.refused) return;
    const api = this.deps.api();
    const key = this.deps.key();
    const desk = this.deps.desk();
    if (!api || !key || !desk) return;
    const tag = (label: string) => tagOf(key.idKey, label);
    const scope = `${desk.id}|${tag('scope')}`;
    const list = tag(SEEN_LIST);
    try {
      await this.read(api, key, desk, scope, list, tag);
      await this.write(api, key, desk, scope, list, tag);
    } catch (error) {
      if (!(error instanceof ServiceRefusal && (error.status === 400 || error.status === 404))) throw error;
      this.refused = true;
      console.error(`[kestrel] Kestrel Connect does not take a record of what was seen yet, so each computer keeps its own: ${message(error)}`);
    }
  }

  private async read(api: HeldApi, key: ReadyKey, desk: Machine, scope: string, list: string, tag: (label: string) => string): Promise<void> {
    const now = this.deps.now?.() ?? Date.now();
    const machines = new Map(this.deps.machines().filter((m) => m.id !== desk.id).map((m) => [m.id, m]));
    const members = [...machines.keys()];
    const known = new Set(this.mark?.members ?? []);
    const joined = members.some((id) => !known.has(id));
    const since = this.mark && this.mark.scope === scope && now - this.mark.at < WHOLE_AFTER_MS && !joined ? this.mark.seq : 0;
    const feed = await api.changes(list, since);
    const last = new Map(feed.changes.map((c) => [c.id, c]));
    const byRecord = new Map(members.map((id) => [tag(seenLabel(id)), id]));
    const records: Record<string, SeenMarks> = {};
    // A machine's record deleted, or (on a whole read) not there at all: it has no marks.
    for (const c of last.values()) if (c.deleted && byRecord.has(c.id)) records[byRecord.get(c.id)!] = {};
    if (since === 0) for (const id of members) records[id] = {};
    const written = [...last.values()].filter((c) => !c.deleted && c.writer !== desk.id && byRecord.get(c.id) === c.writer);
    for (const record of written.length > 0 ? await api.readRecords(written.map((c) => c.id)) : []) {
      if (!record.body) continue;
      try {
        const seen = asSeenRecord(openRecord(this.deps.keyFor(record.generation), record.body, 'record', record.id, record.generation));
        // Only a computer of the keyring, under its own record.
        if (seen && byRecord.get(record.id) === seen.machineId) records[seen.machineId] = seen.marks;
      } catch {
        // Not something this account's key opens: left out.
      }
    }
    await this.deps.source.store.takeAccount(records, members);
    this.mark = { scope, seq: feed.next, at: now, members };
  }

  private async write(api: HeldApi, key: ReadyKey, desk: Machine, scope: string, list: string, tag: (label: string) => string): Promise<void> {
    const { shared, known } = seenScope(await this.deps.source.sessions(), this.deps.keptOff());
    // Before the heads are read, a session of another computer is not known yet: nothing is dropped.
    const own = this.deps.headsRead() ? await this.deps.source.store.prune(known) : await this.deps.source.store.ownMarks();
    const marks = Object.fromEntries(Object.entries(own).filter(([id]) => shared.has(id)));
    const json = JSON.stringify(marks);
    if (this.sent?.scope === scope && this.sent.json === json) return;
    const id = tag(seenLabel(desk.id));
    await api.putRecord(id, { generation: key.generation, session: null, project: null, list, body: sealRecord(key.adk, 'record', id, key.generation, seenRecordOf(desk, marks)) });
    this.sent = { scope, json };
  }

  /** Signed out, or another account: the other computers' marks go; this computer's own stay. */
  async forget(): Promise<void> {
    await this.running?.catch(() => undefined);
    this.sent = null;
    this.mark = null;
    await this.deps.source.store.forgetAccount();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribe();
    if (this.timer) clearTimeout(this.timer);
    await this.running?.catch(() => undefined);
  }
}
