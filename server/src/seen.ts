// The one record of what the user has looked at (Matt, 2026-11-22: "If the user sees it on their phone,
// it should be marked as seen everywhere"; 2026-11-26: "the read state should just be the read state for
// every device"). The server holds it; every window and a phone of the account change it through `mark` and
// `markUnread`, and every window is pushed the new copy. What "seen" means is shared/unread.ts; how the
// account's computers' marks merge is shared/account-seen.ts; this only keeps the record.
//
// It is two parts: the marks made on this computer (`own`), which it holds on Kestrel Connect as its record
// (connect/link/seen-sync.ts), and the other computers' records as last read (`others`). What a window is sent
// is all of them merged, per session the later mark.
import { asMarks, mergeMarks, pruneMarks, seenOfMarks, type SeenMark, type SeenMarks } from './shared/account-seen.ts';
import { activityAt } from './shared/session-order.ts';
import { sanitizeSeen, seenAll, type Seen } from './shared/unread.ts';

/** The setting the marks made here are stored under (since 0.0.33). */
export const SEEN_MARKS_KEY = 'seen-marks';
/** The other computers' records as last read from the account. */
export const SEEN_ACCOUNT_KEY = 'seen-account';
/** Where the record was kept from 0.0.26 to 0.0.33, without when each mark was made; read once to move it. */
export const SEEN_KEY = 'seen';
const UI_STATE_KEY = 'ui-state';

/** A session as the record reads it (shared/unread.ts `activityAt`). */
type Active = { id: string; updatedAt: number; lastActivityAt?: number };

export interface SeenDeps {
  settings: { getSetting(key: string): Promise<string | null>; putSetting(key: string, value: string): Promise<void> };
  /** The sessions there are now, archived ones and other computers' included. */
  sessions: () => Promise<readonly Active[]>;
  now?: () => number;
}

const parse = (json: string | null): unknown => {
  if (json === null) return undefined;
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
};

/** A record kept without when each mark was made: each counts as made when the session was last active, so any real mark since wins. */
const stamped = (seen: Seen): SeenMarks => Object.fromEntries(Object.entries(seen).map(([id, at]) => [id, [at, at] as const]));

function asOthers(value: unknown): Record<string, SeenMarks> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([machine, marks]) => [machine, asMarks(marks)]));
}

const sameSeen = (a: Seen, b: Seen): boolean => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
};

interface Loaded {
  own: SeenMarks;
  others: Readonly<Record<string, SeenMarks>>;
  seen: Seen;
}

export class SeenStore {
  private loaded: Loaded | null = null;
  /** Writes run one after another, so two marks at once cannot lose either. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(seen: Seen) => void>();
  private readonly ownListeners = new Set<() => void>();

  constructor(private readonly deps: SeenDeps) {}

  /** The record now, every computer's marks merged. Read once; the first time it is moved from where older versions kept it. */
  async view(): Promise<Seen> {
    return (await this.serial(() => this.load())).seen;
  }

  /** The marks made on this computer: what it holds on the account as its record. */
  async ownMarks(): Promise<SeenMarks> {
    return (await this.serial(() => this.load())).own;
  }

  /** Called with the new record after every change a window would see. */
  onChange(listener: (seen: Seen) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Called after a mark is made here (not when another computer's arrives): this computer's record is to be sent. */
  onOwnChange(listener: () => void): () => void {
    this.ownListeners.add(listener);
    return () => this.ownListeners.delete(listener);
  }

  /** These sessions were looked at: their activity up to now counts as read. Unknown ids are skipped. */
  mark(sessionIds: readonly string[]): Promise<Seen> {
    return this.changeOwn(async (own, seen) => {
      const wanted = new Set(sessionIds);
      const by = this.now();
      const marks: Record<string, SeenMark> = {};
      for (const s of await this.deps.sessions()) {
        const at = activityAt(s);
        if (wanted.has(s.id) && seen[s.id] !== at) marks[s.id] = [at, by];
      }
      return Object.keys(marks).length === 0 ? own : { ...own, ...marks };
    });
  }

  /** Marked unread by hand: the session's dot comes back until it is looked at again, on every computer. */
  markUnread(sessionId: string): Promise<Seen> {
    return this.changeOwn(async (own, seen) => ((await this.deps.sessions()).some((s) => s.id === sessionId) && seen[sessionId] !== 0 ? { ...own, [sessionId]: [0, this.now()] } : own));
  }

  /**
   * The account's other computers' records as read (seen-sync.ts): `records` replaces those machines' marks,
   * and a machine not in `members` (it left the account) is dropped. Windows are told only when what they show changed.
   */
  takeAccount(records: Readonly<Record<string, SeenMarks>>, members: readonly string[]): Promise<Seen> {
    return this.change((l) => {
      const keep = new Set(members);
      const others = Object.fromEntries(Object.entries({ ...l.others, ...records }).filter(([machine]) => keep.has(machine)));
      return { ...l, others };
    });
  }

  /** Signed out, or another account: nothing of the account's other computers stays. This computer's own marks do. */
  forgetAccount(): Promise<Seen> {
    return this.change((l) => (Object.keys(l.others).length === 0 ? l : { ...l, others: {} }));
  }

  /** Drops this computer's marks of sessions that are nowhere now (`ids`: every session it knows of, here or on the account). */
  prune(ids: ReadonlySet<string>): Promise<SeenMarks> {
    return this.serial(async () => {
      await this.apply(await this.load(), (l) => {
        const own = pruneMarks(l.own, ids);
        return own === l.own ? l : { ...l, own };
      });
      return (await this.load()).own;
    });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private changeOwn(next: (own: SeenMarks, seen: Seen) => Promise<SeenMarks>): Promise<Seen> {
    return this.serial(async () => {
      const before = await this.load();
      const own = await next(before.own, before.seen);
      if (own === before.own) return before.seen;
      const after = await this.apply(before, (l) => ({ ...l, own }));
      for (const listener of this.ownListeners) listener();
      return after.seen;
    });
  }

  private change(next: (loaded: Loaded) => Loaded): Promise<Seen> {
    return this.serial(async () => (await this.apply(await this.load(), next)).seen);
  }

  /** Stores what changed, merges again, and tells the windows when the merged record differs. */
  private async apply(before: Loaded, next: (loaded: Loaded) => Loaded): Promise<Loaded> {
    const changed = next(before);
    if (changed === before) return before;
    if (changed.own !== before.own) await this.deps.settings.putSetting(SEEN_MARKS_KEY, JSON.stringify(changed.own));
    if (changed.others !== before.others) await this.deps.settings.putSetting(SEEN_ACCOUNT_KEY, JSON.stringify(changed.others));
    const merged = seenOfMarks(mergeMarks([changed.own, ...Object.values(changed.others)]));
    const same = sameSeen(merged, before.seen);
    this.loaded = { ...changed, seen: same ? before.seen : merged };
    if (!same) for (const listener of this.listeners) listener(this.loaded.seen);
    return this.loaded;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<Loaded> {
    if (this.loaded) return this.loaded;
    const others = asOthers(parse(await this.deps.settings.getSetting(SEEN_ACCOUNT_KEY)));
    const stored = parse(await this.deps.settings.getSetting(SEEN_MARKS_KEY));
    let own: SeenMarks;
    if (stored !== undefined) own = asMarks(stored);
    else {
      own = stamped(await this.migrate());
      await this.deps.settings.putSetting(SEEN_MARKS_KEY, JSON.stringify(own));
    }
    this.loaded = { own, others, seen: seenOfMarks(mergeMarks([own, ...Object.values(others)])) };
    return this.loaded;
  }

  /**
   * The record as an older version kept it: in `seen` (0.0.26 to 0.0.33), else in the window's `ui-state` (moved
   * out of it); with neither, everything that exists counts as looked at, so no dot lights up because the record moved.
   */
  private async migrate(): Promise<Seen> {
    const older = parse(await this.deps.settings.getSetting(SEEN_KEY));
    if (older !== undefined) return sanitizeSeen(older);
    const ui = parse(await this.deps.settings.getSetting(UI_STATE_KEY));
    const fromWindow = typeof ui === 'object' && ui !== null && !Array.isArray(ui) && 'seen' in ui ? (ui as Record<string, unknown>).seen : undefined;
    if (fromWindow === undefined) return seenAll(await this.deps.sessions());
    const { seen: _moved, ...rest } = ui as Record<string, unknown>;
    await this.deps.settings.putSetting(UI_STATE_KEY, JSON.stringify(rest));
    return sanitizeSeen(fromWindow);
  }
}
