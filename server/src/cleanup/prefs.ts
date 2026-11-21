// Where the cleanup policies are kept (shared/cleanup-policy.ts): one small named setting in the
// store, by `GLOBAL_POLICY` and project id. Shaped like start-base/prefs.ts: writes run one after
// another.
import { sanitizePolicies, withPolicy, type CleanupPolicy, type PolicyByScope } from '../shared/cleanup-policy.ts';
import { memorySettings, type SettingStore } from '../suggestions/prefs.ts';

export const CLEANUP_KEY = 'cleanup-policy';

export class CleanupPrefs {
  private writes: Promise<unknown> = Promise.resolve();
  private readonly store: SettingStore;

  constructor(opts: { settings?: SettingStore } = {}) {
    this.store = opts.settings ?? memorySettings();
  }

  async all(): Promise<PolicyByScope> {
    const raw = await this.store.getSetting(CLEANUP_KEY);
    if (!raw) return {};
    try {
      return sanitizePolicies(JSON.parse(raw));
    } catch {
      return {}; // unreadable: nothing is cleaned up by itself, and the next write replaces it
    }
  }

  /** Sets a scope's policy; null removes a project's own, so it follows the app-wide one again. */
  set(scope: string, policy: CleanupPolicy | null): Promise<PolicyByScope> {
    const work = this.writes.then(async () => {
      const updated = withPolicy(await this.all(), scope, policy);
      await this.store.putSetting(CLEANUP_KEY, JSON.stringify(updated));
      return updated;
    });
    this.writes = work.catch(() => undefined);
    return work;
  }
}
