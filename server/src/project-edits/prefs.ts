// Where "Keep each project's edits in its own session" is kept (shared/project-edits.ts): one
// small named setting in the store, so both persistence backends keep it. Shaped like
// suggestions/prefs.ts: writes run one after another.
import { sanitizeProjectEditPrefs, type ProjectEditPrefs } from '../shared/project-edits.ts';
import { memorySettings, type SettingStore } from '../suggestions/prefs.ts';

export const PROJECT_EDITS_KEY = 'project-edits';

export class ProjectEdits {
  private writes: Promise<unknown> = Promise.resolve();
  private readonly store: SettingStore;

  constructor(opts: { settings?: SettingStore } = {}) {
    this.store = opts.settings ?? memorySettings();
  }

  async prefs(): Promise<ProjectEditPrefs> {
    const raw = await this.store.getSetting(PROJECT_EDITS_KEY);
    if (!raw) return sanitizeProjectEditPrefs(null);
    try {
      return sanitizeProjectEditPrefs(JSON.parse(raw));
    } catch {
      return sanitizeProjectEditPrefs(null); // unreadable: the default, and the next write replaces it
    }
  }

  setKeepInProject(keepInProject: boolean): Promise<ProjectEditPrefs> {
    const work = this.writes.then(async () => {
      const updated: ProjectEditPrefs = { ...(await this.prefs()), keepInProject };
      await this.store.putSetting(PROJECT_EDITS_KEY, JSON.stringify(updated));
      return updated;
    });
    this.writes = work.catch(() => undefined);
    return work;
  }
}
