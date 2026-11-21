// Where each project's remembered answer to "Where should this session start?" is kept
// (shared/start-base.ts): one small named setting in the store, so both persistence backends keep
// it. Shaped like project-edits/prefs.ts: writes run one after another.
import { sanitizeStartBasePrefs, type BaseChoice, type StartBasePrefs } from '../shared/start-base.ts';
import { memorySettings, type SettingStore } from '../suggestions/prefs.ts';

export const START_BASE_KEY = 'start-base';

export class StartBase {
  private writes: Promise<unknown> = Promise.resolve();
  private readonly store: SettingStore;

  constructor(opts: { settings?: SettingStore } = {}) {
    this.store = opts.settings ?? memorySettings();
  }

  async prefs(): Promise<StartBasePrefs> {
    const raw = await this.store.getSetting(START_BASE_KEY);
    if (!raw) return {};
    try {
      return sanitizeStartBasePrefs(JSON.parse(raw));
    } catch {
      return {}; // unreadable: every project is asked again, and the next write replaces it
    }
  }

  async remembered(projectId: string): Promise<BaseChoice | undefined> {
    return (await this.prefs())[projectId];
  }

  /** Remembers `choice` for the project, or forgets it (null): that project is asked again. */
  remember(projectId: string, choice: BaseChoice | null): Promise<StartBasePrefs> {
    const work = this.writes.then(async () => {
      const { [projectId]: _old, ...rest } = await this.prefs();
      const updated: StartBasePrefs = choice ? { ...rest, [projectId]: choice } : rest;
      await this.store.putSetting(START_BASE_KEY, JSON.stringify(updated));
      return updated;
    });
    this.writes = work.catch(() => undefined);
    return work;
  }
}
