// Where each project's setup and archive scripts are kept (shared/project-scripts.ts): one small
// named setting in the store, so both persistence backends keep it. Shaped like start-base/prefs.ts:
// writes run one after another.
import { NO_SCRIPTS, sanitizeScriptsByProject, withScripts, type ProjectScripts, type ScriptsByProject } from '../shared/project-scripts.ts';
import { memorySettings, type SettingStore } from '../suggestions/prefs.ts';

export const PROJECT_SCRIPTS_KEY = 'project-scripts';

export class ProjectScriptsPrefs {
  private writes: Promise<unknown> = Promise.resolve();
  private readonly store: SettingStore;

  constructor(opts: { settings?: SettingStore } = {}) {
    this.store = opts.settings ?? memorySettings();
  }

  async all(): Promise<ScriptsByProject> {
    const raw = await this.store.getSetting(PROJECT_SCRIPTS_KEY);
    if (!raw) return {};
    try {
      return sanitizeScriptsByProject(JSON.parse(raw));
    } catch {
      return {}; // unreadable: no project runs a script, and the next write replaces it
    }
  }

  async of(projectId: string): Promise<ProjectScripts> {
    return (await this.all())[projectId] ?? NO_SCRIPTS;
  }

  set(projectId: string, scripts: ProjectScripts): Promise<ScriptsByProject> {
    const work = this.writes.then(async () => {
      const updated = withScripts(await this.all(), projectId, scripts);
      await this.store.putSetting(PROJECT_SCRIPTS_KEY, JSON.stringify(updated));
      return updated;
    });
    this.writes = work.catch(() => undefined);
    return work;
  }
}
