// A worker node's own update settings (worker-nodes.md 4.2), kept on the node through the Persistence facade as one
// setting, beside the node's Projects settings (project-clone/prefs.ts): "Keep this node on my desktops' version" (on
// by default; `followDesktopVersion` of the closed list another computer may change, shared/node-settings.ts) and the
// version that last failed, with its reason, which is not tried again until Update now.
import { isVersion, type FailedUpdate } from '../shared/node-update.ts';
import { memorySettings, type SettingStore } from '../suggestions/prefs.ts';

export const NODE_UPDATE_KEY = 'node-update';

/** "Keep this node on my desktops' version": the setting's words, wherever it is shown (one key of `NODE_SETTINGS`). */
export { FOLLOW_LABEL } from '../shared/node-settings.ts';

export interface NodeUpdatePrefs {
  /** "Keep this node on my desktops' version". */
  follow: boolean;
  failed: FailedUpdate | null;
}

export const DEFAULT_NODE_UPDATE_PREFS: NodeUpdatePrefs = { follow: true, failed: null };

const REASON_MAX = 1000;

/** Stored settings as read back: anything unknown is the default for that part. */
export function sanitizeNodeUpdatePrefs(value: unknown): NodeUpdatePrefs {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const f = (typeof v.failed === 'object' && v.failed !== null ? v.failed : null) as Record<string, unknown> | null;
  const failed = f && isVersion(f.version) && typeof f.reason === 'string' ? { version: f.version, reason: f.reason.slice(0, REASON_MAX), ...(f.noBuild === true ? { noBuild: true as const } : {}) } : null;
  return { follow: typeof v.follow === 'boolean' ? v.follow : DEFAULT_NODE_UPDATE_PREFS.follow, failed };
}

export class NodeUpdateStore {
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: SettingStore = memorySettings()) {}

  async current(): Promise<NodeUpdatePrefs> {
    const raw = await this.store.getSetting(NODE_UPDATE_KEY);
    if (!raw) return DEFAULT_NODE_UPDATE_PREFS;
    try {
      return sanitizeNodeUpdatePrefs(JSON.parse(raw));
    } catch {
      return DEFAULT_NODE_UPDATE_PREFS; // unreadable: the default, and the next write replaces it
    }
  }

  set(change: Partial<NodeUpdatePrefs>): Promise<NodeUpdatePrefs> {
    const work = this.writes.then(async () => {
      const updated = sanitizeNodeUpdatePrefs({ ...(await this.current()), ...change });
      await this.store.putSetting(NODE_UPDATE_KEY, JSON.stringify(updated));
      return updated;
    });
    this.writes = work.catch(() => undefined);
    return work;
  }
}
