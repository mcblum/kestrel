// Where each project's Git defaults are kept (shared/git-defaults.ts): one small named setting in
// the store. Shaped like start-base/prefs.ts: writes run one after another.
import { AUTOMATIC, sanitizeGitDefaultsByProject, withGitDefaults, type GitDefaults, type GitDefaultsByProject } from '../shared/git-defaults.ts';
import { memorySettings, type SettingStore } from '../suggestions/prefs.ts';

export const GIT_DEFAULTS_KEY = 'git-defaults';

export class GitDefaultsPrefs {
  private writes: Promise<unknown> = Promise.resolve();
  private readonly store: SettingStore;

  constructor(opts: { settings?: SettingStore } = {}) {
    this.store = opts.settings ?? memorySettings();
  }

  async all(): Promise<GitDefaultsByProject> {
    const raw = await this.store.getSetting(GIT_DEFAULTS_KEY);
    if (!raw) return {};
    try {
      return sanitizeGitDefaultsByProject(JSON.parse(raw));
    } catch {
      return {}; // unreadable: every project is automatic, and the next write replaces it
    }
  }

  /** The project's defaults; automatic for a project with none, and for no project. */
  async of(projectId: string | null | undefined): Promise<GitDefaults> {
    return (projectId && (await this.all())[projectId]) || AUTOMATIC;
  }

  set(projectId: string, defaults: GitDefaults): Promise<GitDefaultsByProject> {
    const work = this.writes.then(async () => {
      const updated = withGitDefaults(await this.all(), projectId, defaults);
      await this.store.putSetting(GIT_DEFAULTS_KEY, JSON.stringify(updated));
      return updated;
    });
    this.writes = work.catch(() => undefined);
    return work;
  }
}
