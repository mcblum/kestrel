// Where the model presets and the "Who does what" table are kept (shared/who-does-what.ts): one
// small named setting in the store. Shaped like start-base/prefs.ts: writes run one after another.
import { randomUUID } from 'node:crypto';
import { cleanWhoDoesWhat, NOBODY, sanitizeWhoDoesWhat, type WhoDoesWhat } from '../shared/who-does-what.ts';
import { memorySettings, type SettingStore } from '../suggestions/prefs.ts';

export const WHO_DOES_WHAT_KEY = 'who-does-what';

export class WhoDoesWhatPrefs {
  private writes: Promise<unknown> = Promise.resolve();
  private readonly store: SettingStore;
  private readonly listeners = new Set<() => void>();

  /** Told after each change (a preset added, changed or removed, a role given another). Returns the undo. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  constructor(opts: { settings?: SettingStore } = {}) {
    this.store = opts.settings ?? memorySettings();
  }

  async current(): Promise<WhoDoesWhat> {
    const raw = await this.store.getSetting(WHO_DOES_WHAT_KEY);
    if (!raw) return NOBODY;
    try {
      return sanitizeWhoDoesWhat(JSON.parse(raw));
    } catch {
      return NOBODY; // unreadable: no presets and no roles, and the next write replaces it
    }
  }

  /** Stores a record that passed `whoDoesWhatProblem`; new presets get an id. */
  set(value: unknown): Promise<WhoDoesWhat> {
    const work = this.writes.then(async () => {
      const updated = cleanWhoDoesWhat(value, () => randomUUID().slice(0, 8));
      await this.store.putSetting(WHO_DOES_WHAT_KEY, JSON.stringify(updated));
      for (const listener of this.listeners) listener();
      return updated;
    });
    this.writes = work.catch(() => undefined);
    return work;
  }
}
