// Where Settings → Workflow → "Commit signing" is kept: one small named setting in the store, so
// every persistence provider keeps it (shaped like project-edits/prefs.ts). Writes run one after
// another. Also answers, for a confined session about to start, what its sandbox lets through for
// signing (detect.ts), which is nothing when the switch is off.
import { sanitizeCommitSigningPrefs, type CommitSigningPrefs, type SigningAccess } from '../shared/commit-signing.ts';
import { memorySettings, type SettingStore } from '../suggestions/prefs.ts';
import { detectSigning, systemDetect, type DetectDeps } from './detect.ts';

export const COMMIT_SIGNING_KEY = 'commit-signing';

export interface CommitSigningOptions {
  settings?: SettingStore;
  /** How git and gpgconf are asked; tests pass their own. */
  detect?: DetectDeps;
}

export class CommitSigning {
  private writes: Promise<unknown> = Promise.resolve();
  private readonly store: SettingStore;
  private readonly detect: DetectDeps;

  constructor(opts: CommitSigningOptions = {}) {
    this.store = opts.settings ?? memorySettings();
    this.detect = opts.detect ?? systemDetect();
  }

  async prefs(): Promise<CommitSigningPrefs> {
    const raw = await this.store.getSetting(COMMIT_SIGNING_KEY);
    try {
      return sanitizeCommitSigningPrefs(raw ? JSON.parse(raw) : null);
    } catch {
      return sanitizeCommitSigningPrefs(null); // unreadable: the default, and the next write replaces it
    }
  }

  setAllowed(allowed: boolean): Promise<CommitSigningPrefs> {
    const work = this.writes.then(async () => {
      const updated: CommitSigningPrefs = { ...(await this.prefs()), allowed };
      await this.store.putSetting(COMMIT_SIGNING_KEY, JSON.stringify(updated));
      return updated;
    });
    this.writes = work.catch(() => undefined);
    return work;
  }

  /** What a confined session in `directory` may reach to sign; undefined when the switch is off or the repository does not sign. */
  async accessFor(directory: string): Promise<SigningAccess | undefined> {
    if (!(await this.prefs()).allowed) return undefined;
    return (await detectSigning(directory, this.detect).catch(() => null)) ?? undefined;
  }
}
