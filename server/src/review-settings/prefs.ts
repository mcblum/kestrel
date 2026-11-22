// Where Settings → Code reviews is kept (shared/review-settings.ts): one small named
// setting in the store, so both persistence backends keep it. Shaped like project-edits/prefs.ts:
// writes run one after another. Listeners hear each stored change (the sync and the starter).
import { DEFAULT_REVIEW_SETTINGS, sanitizeReviewSettings, type ReviewSettings } from '../shared/review-settings.ts';
import { memorySettings, type SettingStore } from '../suggestions/prefs.ts';

export const REVIEW_SETTINGS_KEY = 'review-requests';

export type ReviewSettingsListener = (settings: ReviewSettings) => void;

export class ReviewPrefs {
  private writes: Promise<unknown> = Promise.resolve();
  private readonly store: SettingStore;
  private readonly listeners = new Set<ReviewSettingsListener>();

  constructor(opts: { settings?: SettingStore } = {}) {
    this.store = opts.settings ?? memorySettings();
  }

  async current(): Promise<ReviewSettings> {
    const raw = await this.store.getSetting(REVIEW_SETTINGS_KEY);
    if (!raw) return DEFAULT_REVIEW_SETTINGS;
    try {
      return sanitizeReviewSettings(JSON.parse(raw));
    } catch {
      return DEFAULT_REVIEW_SETTINGS; // unreadable: the default, and the next write replaces it
    }
  }

  /** Change what is given and keep the rest. */
  set(change: Partial<ReviewSettings>): Promise<ReviewSettings> {
    const work = this.writes.then(async () => {
      const updated = sanitizeReviewSettings({ ...(await this.current()), ...change });
      await this.store.putSetting(REVIEW_SETTINGS_KEY, JSON.stringify(updated));
      for (const listener of this.listeners) listener(updated);
      return updated;
    });
    this.writes = work.catch(() => undefined);
    return work;
  }

  onChange(listener: ReviewSettingsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
