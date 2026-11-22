// The one record of what the user has looked at (Matt, 2026-11-22: "If the user sees it on their phone,
// it should be marked as seen everywhere"). The server holds it; every window and a paired phone change it
// through `mark` and `markUnread`, and every window is pushed the new copy. What "seen" means is
// shared/unread.ts; this only keeps the record.
import { markSeen, sanitizeSeen, seenAll, type Seen } from './shared/unread.ts';

/** The setting it is stored under. Before 0.0.26 it lived inside the window's `ui-state`. */
export const SEEN_KEY = 'seen';
const UI_STATE_KEY = 'ui-state';

/** A session as the record reads it (shared/unread.ts `activityAt`). */
type Active = { id: string; updatedAt: number; lastActivityAt?: number };

export interface SeenDeps {
  settings: { getSetting(key: string): Promise<string | null>; putSetting(key: string, value: string): Promise<void> };
  /** The sessions there are now, archived ones included. */
  sessions: () => Promise<readonly Active[]>;
}

const parse = (json: string | null): unknown => {
  if (json === null) return undefined;
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
};

export class SeenStore {
  private seen: Seen | null = null;
  /** Writes run one after another, so two marks at once cannot lose either. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(seen: Seen) => void>();

  constructor(private readonly deps: SeenDeps) {}

  /** The record now. Read once; the first time it is moved out of `ui-state`, or made from what exists. */
  view(): Promise<Seen> {
    return this.serial(() => this.load());
  }

  /** Called with the new record after every change. */
  onChange(listener: (seen: Seen) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** These sessions were looked at: their activity up to now counts as read. Unknown ids are skipped. */
  mark(sessionIds: readonly string[]): Promise<Seen> {
    return this.change(async (seen) => {
      const wanted = new Set(sessionIds);
      return (await this.deps.sessions()).filter((s) => wanted.has(s.id)).reduce(markSeen, seen);
    });
  }

  /** Marked unread by hand: the session's dot comes back until it is looked at again. */
  markUnread(sessionId: string): Promise<Seen> {
    return this.change(async (seen) => ((await this.deps.sessions()).some((s) => s.id === sessionId) && seen[sessionId] !== 0 ? { ...seen, [sessionId]: 0 } : seen));
  }

  private change(next: (seen: Seen) => Promise<Seen>): Promise<Seen> {
    return this.serial(async () => {
      const before = await this.load();
      const after = await next(before);
      if (after === before) return before;
      await this.deps.settings.putSetting(SEEN_KEY, JSON.stringify(after));
      this.seen = after;
      for (const listener of this.listeners) listener(after);
      return after;
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<Seen> {
    if (this.seen) return this.seen;
    const stored = parse(await this.deps.settings.getSetting(SEEN_KEY));
    if (stored !== undefined) return (this.seen = sanitizeSeen(stored));
    this.seen = await this.migrate();
    await this.deps.settings.putSetting(SEEN_KEY, JSON.stringify(this.seen));
    return this.seen;
  }

  /**
   * The record the window kept in `ui-state` before 0.0.26, taken out of it; with none, everything
   * that exists counts as looked at, so no dot lights up because the record moved.
   */
  private async migrate(): Promise<Seen> {
    const ui = parse(await this.deps.settings.getSetting(UI_STATE_KEY));
    const fromWindow = typeof ui === 'object' && ui !== null && !Array.isArray(ui) && 'seen' in ui ? (ui as Record<string, unknown>).seen : undefined;
    if (fromWindow === undefined) return seenAll(await this.deps.sessions());
    const { seen: _moved, ...rest } = ui as Record<string, unknown>;
    await this.deps.settings.putSetting(UI_STATE_KEY, JSON.stringify(rest));
    return sanitizeSeen(fromWindow);
  }
}
