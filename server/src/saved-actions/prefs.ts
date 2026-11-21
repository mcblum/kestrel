// Where each project's saved actions are kept (shared/saved-actions.ts): one small named setting
// in the store. Shaped like start-base/prefs.ts: writes run one after another.
import { randomUUID } from 'node:crypto';
import { cleanActions, sanitizeActionsByProject, withActions, type ActionsByProject, type SavedAction } from '../shared/saved-actions.ts';
import { memorySettings, type SettingStore } from '../suggestions/prefs.ts';

export const SAVED_ACTIONS_KEY = 'saved-actions';

export class SavedActionsPrefs {
  private writes: Promise<unknown> = Promise.resolve();
  private readonly store: SettingStore;

  constructor(opts: { settings?: SettingStore } = {}) {
    this.store = opts.settings ?? memorySettings();
  }

  async all(): Promise<ActionsByProject> {
    const raw = await this.store.getSetting(SAVED_ACTIONS_KEY);
    if (!raw) return {};
    try {
      return sanitizeActionsByProject(JSON.parse(raw));
    } catch {
      return {}; // unreadable: no project has actions, and the next write replaces it
    }
  }

  async of(projectId: string): Promise<readonly SavedAction[]> {
    return (await this.all())[projectId] ?? [];
  }

  /** Replaces the project's actions with a list that passed `actionsProblem`; new ones get an id. */
  set(projectId: string, actions: readonly unknown[]): Promise<ActionsByProject> {
    const work = this.writes.then(async () => {
      const updated = withActions(await this.all(), projectId, cleanActions(actions, () => randomUUID().slice(0, 8)));
      await this.store.putSetting(SAVED_ACTIONS_KEY, JSON.stringify(updated));
      return updated;
    });
    this.writes = work.catch(() => undefined);
    return work;
  }
}
