// The one copy of every session's pull requests on the server. Each session's last answer is kept
// for as long as the server runs (never thrown away on a timer), and asked for again:
//   - when a route asks with a different repository, branch or links than last time (`get`'s key);
//   - in the background, at the pace its last answer calls for, or every few seconds while a window
//     has the session open (shared/pull-request-poll.ts), while some window is connected (`tick`);
//   - at once when asked to (Refresh, a merge: `get` with refresh, or `due`).
// A question already on its way is shared, not asked twice. Listeners hear about a session only when
// its answer really changed, so the UI, which holds what is pushed (ui/src/store.ts), re-renders only
// then. The clock is injected, so tests never wait.
//
// It also holds, while Autopilot watches one, the pipeline on the commit a session's merged request put on
// its target branch (`watchPipeline`, `pipeline`): asked at once, then every CHANGING_POLL_MS until it has
// passed or failed, by the same background tick, and told to its own listeners (`onPipelineChange`).
import { CHANGING_POLL_MS, nextPullRequestAsk } from '../shared/pull-request-poll.ts';
import type { BasePipeline, PullRequestLookup } from '../shared/details.ts';
import { carryConflictsSince } from '../shared/request-attention.ts';
import { reasonOf, unavailable, type Sourced } from '../shared/sourced.ts';

type Lookup = Sourced<PullRequestLookup>;
type Load = () => Promise<Lookup>;

/**
 * Each request's `headSeenAt` carried over from the last answer while its head commit is the same, else
 * `now`: when the store first saw that commit. Returns `after` itself when nothing changes. Pure.
 */
export function carryHeadSeen(before: Lookup | undefined, after: Lookup, now: number): Lookup {
  if (after.state !== 'ready') return after;
  const was = before?.state === 'ready' ? before.value.pullRequests : [];
  let changed = false;
  const pullRequests = after.value.pullRequests.map((p) => {
    if (!p.headSha) return p;
    const earlier = was.find((w) => w.number === p.number && w.headSha === p.headSha);
    const seen = earlier?.headSeenAt ?? p.headSeenAt ?? now;
    if (seen === p.headSeenAt) return p;
    changed = true;
    return { ...p, headSeenAt: seen };
  });
  return changed ? { ...after, value: { ...after.value, pullRequests } } : after;
}

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

type Pipeline = Sourced<BasePipeline>;

/** One watched pipeline: which commit and branch (`key`), how to ask, and the last answer. */
interface PipelineEntry {
  key: string;
  load: () => Promise<Pipeline>;
  value?: Pipeline;
  askedAt: number | null;
  inFlight?: Promise<Pipeline>;
}

/** What the store holds a watched pipeline under: the target branch and the commit. */
export const pipelineKey = (base: string, sha: string): string => `${base}\n${sha}`;

/** When a watched pipeline is asked about again: soon until it has passed or failed, then never. Pure. */
export function nextPipelineAsk(value: Pipeline | undefined, askedAt: number | null): number | null {
  if (askedAt === null) return null;
  if (value?.state === 'ready' && (value.value.checks === 'passing' || value.value.checks === 'failing')) return null;
  return askedAt + CHANGING_POLL_MS;
}

export class PullRequestStore {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<PullRequestListener>();
  private readonly pipelines = new Map<string, PipelineEntry>();
  private readonly pipelineListeners = new Set<(sessionId: string) => void>();

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

  /** The session's answer once a question already on its way is in, else what is held; never asks the host. */
  settled(sessionId: string): Promise<Lookup | undefined> {
    const entry = this.entries.get(sessionId);
    return entry?.inFlight ?? Promise.resolve(entry?.value);
  }

  /**
   * The session's answer, asked again first when it has none yet or its time to be asked has come
   * (`nextPullRequestAsk`): what Autopilot reads when it is turned on. A question on its way is waited
   * for. Undefined when the store has never been told how to ask about the session.
   */
  current(sessionId: string): Promise<Lookup | undefined> {
    const entry = this.entries.get(sessionId);
    if (!entry) return Promise.resolve(undefined);
    if (entry.inFlight) return entry.inFlight;
    if (entry.value && entry.askedAt !== null && !entry.dueNow) {
      const next = nextPullRequestAsk(entry.value, entry.askedAt, false);
      if (next === null || next > this.now()) return Promise.resolve(entry.value);
    }
    return this.run(sessionId, entry);
  }

  /** Ask about this session again on the next tick (after a merge, say). Its answer stays shown meanwhile. */
  due(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry) entry.dueNow = true;
  }

  /** The session is gone or out of sight. */
  forget(sessionId: string): void {
    this.unwatchPipeline(sessionId);
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.entries.delete(sessionId);
    if (entry.value) this.notify(sessionId, null);
  }

  /**
   * Keep the pipeline `key` names (a commit on a branch) current for the session, asked with `load`: at
   * once when it is new, then by `tick`. The same key again changes nothing.
   */
  watchPipeline(sessionId: string, key: string, load: () => Promise<Pipeline>): void {
    const entry = this.pipelines.get(sessionId);
    if (entry && entry.key === key) {
      entry.load = load;
      return;
    }
    const next: PipelineEntry = { key, load, askedAt: null };
    this.pipelines.set(sessionId, next);
    void this.runPipeline(sessionId, next);
  }

  /** The pipeline held for the session under `key`, if there is an answer for that one. */
  pipeline(sessionId: string, key: string): Pipeline | undefined {
    const entry = this.pipelines.get(sessionId);
    return entry?.key === key ? entry.value : undefined;
  }

  /** The session's watch is over: its pipeline is no longer asked about. */
  unwatchPipeline(sessionId: string): void {
    this.pipelines.delete(sessionId);
  }

  onPipelineChange(listener: (sessionId: string) => void): () => void {
    this.pipelineListeners.add(listener);
    return () => this.pipelineListeners.delete(listener);
  }

  /** Every session the store holds. */
  ids(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * Ask again about every session whose time has come, at most BACKGROUND_CONCURRENCY at once.
   * `watched` says which sessions a window has open: those are asked about every few seconds.
   * `kept` says which sessions are asked about every CHANGING_POLL_MS even once their requests are merged or
   * closed: Autopilot waits there for the request a round is opening to fix the target branch's pipeline.
   */
  async tick(watched: (sessionId: string) => boolean = () => false, kept: (sessionId: string) => boolean = () => false): Promise<void> {
    const now = this.now();
    const isDue = (id: string, e: Entry): boolean => {
      if (e.inFlight) return false;
      if (e.dueNow) return true;
      if (!e.value || e.askedAt === null) return false;
      const paced = nextPullRequestAsk(e.value, e.askedAt, watched(id));
      const next = kept(id) ? Math.min(paced ?? Infinity, e.askedAt + CHANGING_POLL_MS) : paced;
      return next !== null && next <= now;
    };
    const due = [...this.entries].filter(([id, e]) => isDue(id, e)).slice(0, BACKGROUND_CONCURRENCY);
    const pipelinesDue = [...this.pipelines].filter(([, e]) => {
      const next = e.inFlight ? null : nextPipelineAsk(e.value, e.askedAt);
      return next !== null && next <= now;
    });
    const room = Math.max(0, BACKGROUND_CONCURRENCY - due.length);
    await Promise.all([...due.map(([id, entry]) => this.run(id, entry)), ...pipelinesDue.slice(0, room).map(([id, entry]) => this.runPipeline(id, entry))]);
  }

  private runPipeline(sessionId: string, entry: PipelineEntry): Promise<Pipeline> {
    if (entry.inFlight) return entry.inFlight;
    const flight = entry
      .load()
      .catch((error: unknown) => unavailable(reasonOf(error)))
      .then((answered) => {
        entry.inFlight = undefined;
        if (this.pipelines.get(sessionId) !== entry) return answered;
        entry.askedAt = this.now();
        const changed = JSON.stringify(answered) !== JSON.stringify(entry.value);
        entry.value = answered;
        if (changed) for (const listener of this.pipelineListeners) listener(sessionId);
        return answered;
      });
    entry.inFlight = flight;
    return flight;
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
      // And each head commit keeps the time it was first seen (Autopilot measures a new commit's checks from it).
      const value = carryHeadSeen(entry.value, carryConflictsSince(entry.value, answered), this.now());
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
