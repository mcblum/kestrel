// The one copy of every session's pull requests on the server. Each session's last answer is kept
// for as long as the server runs (never thrown away on a timer), and asked for again:
//   - when a route asks with a different repository, branch or links than last time (`get`'s key);
//   - in the background, at the pace its last answer calls for, or every few seconds while a window
//     has the session open (shared/pull-request-poll.ts), while some window is connected (`tick`);
//   - at once when asked to (Refresh, a merge: `get` with refresh, or `due`).
// A question already on its way is shared, not asked twice. Listeners hear about a session only when
// its answer really changed, so the UI, which holds what is pushed (ui/src/store.ts), re-renders only
// then. The clock is injected, so tests never wait.
import { nextPullRequestAsk } from '../shared/pull-request-poll.ts';
import type { PullRequestLookup } from '../shared/details.ts';
import { carryConflictsSince } from '../shared/request-attention.ts';
import { reasonOf, unavailable, type Sourced } from '../shared/sourced.ts';

type Lookup = Sourced<PullRequestLookup>;
type Load = () => Promise<Lookup>;

/** How many background lookups run at once: each may run gh or glab. */
export const BACKGROUND_CONCURRENCY = 4;

interface Entry {
  key: string;
  /** The latest way to ask again (the background refresh uses it). */
  load: Load;
  /** The last answer, once there is one. */
  value?: Lookup;
  /** Its JSON, to tell a real change from the same answer again. */
  json?: string;
  /** When it was last answered, and so when it is asked again (`nextPullRequestAsk`); null before its first answer. */
  askedAt: number | null;
  /** Asked for now, whatever the pace says (`due`). */
  dueNow?: boolean;
  inFlight?: Promise<Lookup>;
}

export type PullRequestListener = (sessionId: string, value: Lookup | null) => void;

export class PullRequestStore {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<PullRequestListener>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * The session's answer. Kept while the key (repository, branch, links) is the same, however old:
   * the background refresh keeps it current. A new key, no answer yet, or `refresh` asks now.
   */
  get(sessionId: string, key: string, load: Load, refresh = false): Promise<Lookup> {
    const entry = this.entries.get(sessionId);
    if (entry && entry.key === key) {
      entry.load = load;
      if (!refresh && entry.value) return Promise.resolve(entry.value);
      if (!refresh && entry.inFlight) return entry.inFlight;
    }
    const next: Entry = entry && entry.key === key ? entry : { key, load, askedAt: null, ...(entry?.value ? { value: entry.value, json: entry.json } : {}) };
    this.entries.set(sessionId, next);
    return this.run(sessionId, next);
  }

  /** The last answer of every session that has one. */
  all(): Record<string, Lookup> {
    const out: Record<string, Lookup> = {};
    for (const [id, entry] of this.entries) if (entry.value) out[id] = entry.value;
    return out;
  }

  /** The session's last answer, if it has one. */
  peek(sessionId: string): Lookup | undefined {
    return this.entries.get(sessionId)?.value;
  }

  /** Ask about this session again on the next tick (after a merge, say). Its answer stays shown meanwhile. */
  due(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry) entry.dueNow = true;
  }

  /** The session is gone or out of sight. */
  forget(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.entries.delete(sessionId);
    if (entry.value) this.notify(sessionId, null);
  }

  /** Every session the store holds. */
  ids(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * Ask again about every session whose time has come, at most BACKGROUND_CONCURRENCY at once.
   * `watched` says which sessions a window has open: those are asked about every few seconds.
   */
  async tick(watched: (sessionId: string) => boolean = () => false): Promise<void> {
    const now = this.now();
    const isDue = (id: string, e: Entry): boolean => {
      if (e.inFlight) return false;
      if (e.dueNow) return true;
      if (!e.value || e.askedAt === null) return false;
      const next = nextPullRequestAsk(e.value, e.askedAt, watched(id));
      return next !== null && next <= now;
    };
    const due = [...this.entries].filter(([id, e]) => isDue(id, e)).slice(0, BACKGROUND_CONCURRENCY);
    await Promise.all(due.map(([id, entry]) => this.run(id, entry)));
  }

  onChange(listener: PullRequestListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private run(sessionId: string, entry: Entry): Promise<Lookup> {
    if (entry.inFlight) return entry.inFlight;
    const asked = entry.load().catch((error: unknown) => unavailable(reasonOf(error)));
    const flight = asked.then((answered) => {
      entry.inFlight = undefined;
      // A request that keeps conflicting keeps the commit it was first seen conflicting at (shared/request-attention.ts).
      const value = carryConflictsSince(entry.value, answered);
      // Forgotten, or replaced by a newer key, while it was on its way: the answer is not this entry's any more.
      if (this.entries.get(sessionId) !== entry) return value;
      entry.askedAt = this.now();
      entry.dueNow = false;
      const json = JSON.stringify(value);
      if (json === entry.json && entry.value) return entry.value;
      entry.value = value;
      entry.json = json;
      this.notify(sessionId, value);
      return value;
    });
    entry.inFlight = flight;
    return flight;
  }

  private notify(sessionId: string, value: Lookup | null): void {
    for (const listener of this.listeners) listener(sessionId, value);
  }
}
