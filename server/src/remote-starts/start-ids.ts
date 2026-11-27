// A start asked by another device is carried out once (item 81; worker-nodes.md, section 10). The starting device
// makes an id for each start and sends the same one again when it retries, because the first answer came too late
// for it. This computer remembers which session each recent id started, in a setting of the store (so through the
// Persistence facade, and a restart inside the retry window still knows it), and answers a repeated id with that
// session. A repeat that arrives while the first is still being accepted waits for it. A start with no id (an older
// device) is carried out as before.
import type { SettingStore } from '../suggestions/prefs.ts';

export const START_IDS_KEY = 'remote-start-ids';
/**
 * How long a start id is remembered. Far longer than a starting device retries (two waits of `START_TIMEOUT_MS`), so a
 * person who sends the same draft again after "did not answer in time" still gets the session that started.
 */
export const START_ID_KEPT_MS = 24 * 60 * 60 * 1000;
/** At most this many are kept, the newest: the setting stays small however many starts there are. */
export const START_IDS_MAX = 200;

export interface StartedById {
  id: string;
  sessionId: string;
  at: number;
}

/** The ids as stored, the unreadable ones dropped. Pure. */
export function parseStartIds(raw: string | null): StartedById[] {
  let value: unknown;
  try {
    value = raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => {
    const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
    return typeof o.id === 'string' && typeof o.sessionId === 'string' && typeof o.at === 'number' && Number.isFinite(o.at) ? [{ id: o.id, sessionId: o.sessionId, at: o.at }] : [];
  });
}

/** The session a start id started, while it is remembered; null when it started none. Pure. */
export function startedBy(list: readonly StartedById[], id: string, now: number): string | null {
  return list.find((s) => s.id === id && now - s.at < START_ID_KEPT_MS)?.sessionId ?? null;
}

/** The list with one more start, the expired ones gone and at most `START_IDS_MAX` kept, newest first. Pure. */
export function withStart(list: readonly StartedById[], started: StartedById, now: number): StartedById[] {
  return [started, ...list.filter((s) => s.id !== started.id && now - s.at < START_ID_KEPT_MS)].slice(0, START_IDS_MAX);
}

export class StartIds {
  /** Starts being accepted now, by id: a repeat waits for the first instead of starting a second. In memory: it lasts one start. */
  private readonly accepting = new Map<string, Promise<{ sessionId: string; again: boolean }>>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: SettingStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** The session `id` started, if it is remembered. */
  async started(id: string): Promise<string | null> {
    return startedBy(parseStartIds(await this.store.getSetting(START_IDS_KEY)), id, this.now());
  }

  /**
   * Carries out `start` once per id: a repeat gets the session the first made (`again` true). `start` answers the
   * session's id once its row exists. A refused start is not remembered, so asking again with the same id tries again.
   */
  async once(id: string, start: () => Promise<string>): Promise<{ sessionId: string; again: boolean }> {
    const under = this.accepting.get(id);
    if (under) return { sessionId: (await under).sessionId, again: true };
    // Marked as being accepted before anything is awaited, so a repeat that arrives meanwhile waits for this one.
    const work = (async () => {
      const known = await this.started(id);
      if (known) return { sessionId: known, again: true };
      const sessionId = await start();
      await this.remember(id, sessionId);
      return { sessionId, again: false };
    })();
    this.accepting.set(id, work);
    try {
      return await work;
    } finally {
      this.accepting.delete(id);
    }
  }

  private remember(id: string, sessionId: string): Promise<void> {
    const work = this.writes.then(async () => {
      const now = this.now();
      const list = parseStartIds(await this.store.getSetting(START_IDS_KEY));
      await this.store.putSetting(START_IDS_KEY, JSON.stringify(withStart(list, { id, sessionId, at: now }, now)));
    });
    this.writes = work.catch(() => undefined);
    return work;
  }
}
