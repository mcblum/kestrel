// Settings → Workflow → "Other devices may start sessions on this computer" (A8 in account-sessions.md;
// kestrel-connect.md, "Actions"). On by default. Off, a start asked by another device of the account is
// refused with `REMOTE_STARTS_OFF`. Kept on this computer only: it is this computer's own choice.
import { memorySettings, type SettingStore } from '../suggestions/prefs.ts';

export const REMOTE_STARTS_KEY = 'remote-starts';

export interface RemoteStartPrefs {
  allowed: boolean;
}

export const DEFAULT_REMOTE_START_PREFS: RemoteStartPrefs = { allowed: true };

/** The refusal, naming this computer as every Connect refusal does ("your Mac"). */
export const remoteStartsOff = (here: string): string => `Starting sessions on ${here} from other devices is off in its Settings.`;

export function sanitizeRemoteStartPrefs(value: unknown): RemoteStartPrefs {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<RemoteStartPrefs>;
  return { allowed: typeof v.allowed === 'boolean' ? v.allowed : DEFAULT_REMOTE_START_PREFS.allowed };
}

export class RemoteStarts {
  private writes: Promise<unknown> = Promise.resolve();
  private readonly store: SettingStore;
  private readonly listeners = new Set<() => void>();

  /** Told after each change of the switch. Returns the undo. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  constructor(opts: { settings?: SettingStore } = {}) {
    this.store = opts.settings ?? memorySettings();
  }

  async prefs(): Promise<RemoteStartPrefs> {
    const raw = await this.store.getSetting(REMOTE_STARTS_KEY);
    if (!raw) return DEFAULT_REMOTE_START_PREFS;
    try {
      return sanitizeRemoteStartPrefs(JSON.parse(raw));
    } catch {
      return DEFAULT_REMOTE_START_PREFS; // unreadable: the default, and the next write replaces it
    }
  }

  setAllowed(allowed: boolean): Promise<RemoteStartPrefs> {
    const work = this.writes.then(async () => {
      const updated: RemoteStartPrefs = { ...(await this.prefs()), allowed };
      await this.store.putSetting(REMOTE_STARTS_KEY, JSON.stringify(updated));
      for (const listener of this.listeners) listener();
      return updated;
    });
    this.writes = work.catch(() => undefined);
    return work;
  }
}
