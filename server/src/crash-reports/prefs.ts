// Where Settings → General → "Crash reports" is kept: one small named setting in the store, so
// every persistence provider keeps it (shaped like commit-signing/prefs.ts). Writes run one after
// another. `current()` is what the reporter asks before each report, without waiting on the store.
import { DEFAULT_CRASH_REPORT_PREFS, sanitizeCrashReportPrefs, type CrashReportPrefs } from '../shared/crash-reports.ts';
import { memorySettings, type SettingStore } from '../suggestions/prefs.ts';

export const CRASH_REPORTS_KEY = 'crash-reports';

export interface CrashReportsOptions {
  settings?: SettingStore;
}

export class CrashReports {
  private writes: Promise<unknown> = Promise.resolve();
  private readonly store: SettingStore;
  private latest: CrashReportPrefs = DEFAULT_CRASH_REPORT_PREFS;

  constructor(opts: CrashReportsOptions = {}) {
    this.store = opts.settings ?? memorySettings();
  }

  async prefs(): Promise<CrashReportPrefs> {
    const raw = await this.store.getSetting(CRASH_REPORTS_KEY);
    try {
      this.latest = sanitizeCrashReportPrefs(raw ? JSON.parse(raw) : null);
    } catch {
      this.latest = sanitizeCrashReportPrefs(null); // unreadable: the default, and the next write replaces it
    }
    return this.latest;
  }

  /** The switch as last read or written. Call `prefs()` once at start so this is the stored value. */
  current(): CrashReportPrefs {
    return this.latest;
  }

  setEnabled(enabled: boolean): Promise<CrashReportPrefs> {
    const work = this.writes.then(async () => {
      const updated: CrashReportPrefs = { ...(await this.prefs()), enabled };
      await this.store.putSetting(CRASH_REPORTS_KEY, JSON.stringify(updated));
      this.latest = updated;
      return updated;
    });
    this.writes = work.catch(() => undefined);
    return work;
  }
}
