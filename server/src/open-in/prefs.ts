// Where the default "Open in" app is kept (Settings → Workflow; shared/file-menu.ts): one small
// named setting in the store, so both persistence backends keep it. Shaped like
// project-edits/prefs.ts: writes run one after another.
import { sanitizeOpenInPrefs, type OpenInPrefs } from '../shared/file-menu.ts';
import { memorySettings, type SettingStore } from '../suggestions/prefs.ts';

export const OPEN_IN_KEY = 'open-in';

export class OpenIn {
  private writes: Promise<unknown> = Promise.resolve();
  private readonly store: SettingStore;

  constructor(opts: { settings?: SettingStore } = {}) {
    this.store = opts.settings ?? memorySettings();
  }

  async prefs(): Promise<OpenInPrefs> {
    const raw = await this.store.getSetting(OPEN_IN_KEY);
    if (!raw) return sanitizeOpenInPrefs(null);
    try {
      return sanitizeOpenInPrefs(JSON.parse(raw));
    } catch {
      return sanitizeOpenInPrefs(null); // unreadable: the default, and the next write replaces it
    }
  }

  /** `null` goes back to Kestrel's own choice (VS Code when it is installed). */
  setDefaultApp(defaultApp: string | null): Promise<OpenInPrefs> {
    const work = this.writes.then(async () => {
      const updated = sanitizeOpenInPrefs({ ...(await this.prefs()), defaultApp });
      await this.store.putSetting(OPEN_IN_KEY, JSON.stringify(updated));
      return updated;
    });
    this.writes = work.catch(() => undefined);
    return work;
  }
}
