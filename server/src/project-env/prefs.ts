// Where the environment settings are kept (shared/project-env.ts): one small named setting in the
// store, by project id and `GLOBAL_ENV`. Shaped like start-base/prefs.ts: writes run one after
// another. Values are stored as typed, in Kestrel's own database: a secret belongs in a .env file
// that is listed here, not in the variables.
import { NO_ENV, sanitizeEnvByScope, withEnv, type EnvByScope, type EnvSettings } from '../shared/project-env.ts';
import { memorySettings, type SettingStore } from '../suggestions/prefs.ts';

export const PROJECT_ENV_KEY = 'project-env';

export class ProjectEnvPrefs {
  private writes: Promise<unknown> = Promise.resolve();
  private readonly store: SettingStore;

  constructor(opts: { settings?: SettingStore } = {}) {
    this.store = opts.settings ?? memorySettings();
  }

  async all(): Promise<EnvByScope> {
    const raw = await this.store.getSetting(PROJECT_ENV_KEY);
    if (!raw) return {};
    try {
      return sanitizeEnvByScope(JSON.parse(raw));
    } catch {
      return {}; // unreadable: nothing is added to any session, and the next write replaces it
    }
  }

  async of(scope: string): Promise<EnvSettings> {
    return (await this.all())[scope] ?? NO_ENV;
  }

  set(scope: string, env: EnvSettings): Promise<EnvByScope> {
    const work = this.writes.then(async () => {
      const updated = withEnv(await this.all(), scope, env);
      await this.store.putSetting(PROJECT_ENV_KEY, JSON.stringify(updated));
      return updated;
    });
    this.writes = work.catch(() => undefined);
    return work;
  }
}
