// Where Settings → Workflow → Notifications is kept (shared/notifications.ts): one small named
// setting in the store. Shaped like start-base/prefs.ts: writes run one after another.
import { DEFAULT_NOTIFY, sanitizeNotify, type NotifyPrefs } from '../shared/notifications.ts';
import { memorySettings, type SettingStore } from '../suggestions/prefs.ts';

export const NOTIFY_KEY = 'notifications';

export class NotifyPrefsStore {
  private writes: Promise<unknown> = Promise.resolve();
  private readonly store: SettingStore;

  constructor(opts: { settings?: SettingStore } = {}) {
    this.store = opts.settings ?? memorySettings();
  }

  async prefs(): Promise<NotifyPrefs> {
    const raw = await this.store.getSetting(NOTIFY_KEY);
    if (!raw) return DEFAULT_NOTIFY;
    try {
      return sanitizeNotify(JSON.parse(raw));
    } catch {
      return DEFAULT_NOTIFY; // unreadable: the defaults, and the next write replaces it
    }
  }

  set(prefs: NotifyPrefs): Promise<NotifyPrefs> {
    const work = this.writes.then(async () => {
      await this.store.putSetting(NOTIFY_KEY, JSON.stringify(prefs));
      return prefs;
    });
    this.writes = work.catch(() => undefined);
    return work;
  }
}
