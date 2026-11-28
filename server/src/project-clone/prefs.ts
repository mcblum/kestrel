// A worker node's Projects settings (worker-nodes.md 9.3; the values and words are shared/node-push.ts): whether it
// mirrors every project of the account, and whether it pushes each session's branch when a turn ends: `projects` and
// `push` of the closed list another computer may change (shared/node-settings.ts). Kept on this computer through the
// Persistence facade (a setting), under the key they were first stored under, so a stored value is kept.
import { DEFAULT_NODE_PROJECT_PREFS, sanitizeNodeProjectPrefs, type NodeProjectPrefs } from '../shared/node-push.ts';
import { memorySettings, type SettingStore } from '../suggestions/prefs.ts';

export const NODE_PROJECT_PREFS_KEY = 'node-projects';

export class NodeProjectPrefsStore {
  private writes: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly store: SettingStore = memorySettings()) {}

  /** Told after each change. Returns the undo. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  async current(): Promise<NodeProjectPrefs> {
    const raw = await this.store.getSetting(NODE_PROJECT_PREFS_KEY);
    if (!raw) return DEFAULT_NODE_PROJECT_PREFS;
    try {
      return sanitizeNodeProjectPrefs(JSON.parse(raw));
    } catch {
      return DEFAULT_NODE_PROJECT_PREFS; // unreadable: the default, and the next write replaces it
    }
  }

  set(change: Partial<NodeProjectPrefs>): Promise<NodeProjectPrefs> {
    const work = this.writes.then(async () => {
      const updated = sanitizeNodeProjectPrefs({ ...(await this.current()), ...change });
      await this.store.putSetting(NODE_PROJECT_PREFS_KEY, JSON.stringify(updated));
      for (const listener of this.listeners) listener();
      return updated;
    });
    this.writes = work.catch(() => undefined);
    return work;
  }
}
