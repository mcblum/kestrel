import { describe, expect, test } from 'vitest';
import { crashReportSetup, sanitizeCrashReportPrefs, scrubHome, scrubReport } from '../shared/crash-reports.ts';
import { memorySettings } from '../suggestions/prefs.ts';
import { crashReportsRoute } from './api.ts';
import { CRASH_REPORTS_KEY, CrashReports } from './prefs.ts';

const DSN = 'https://key@whoops.example/1';

describe('crashReportSetup', () => {
  test('never reports when there is no address', () => {
    expect(crashReportSetup({ packaged: true, version: '1.2.3' }, '')).toBeNull();
  });

  test('never reports from a checkout', () => {
    expect(crashReportSetup({ packaged: false, version: '1.2.3' }, DSN)).toBeNull();
  });

  test('the installed app reports as production, named by its version', () => {
    expect(crashReportSetup({ packaged: true, version: '1.2.3' }, DSN)).toEqual({ dsn: DSN, release: 'kestrel@1.2.3', environment: 'production' });
  });

  test('a test address makes a checkout report, as development', () => {
    expect(crashReportSetup({ packaged: false, version: '1.2.3', dsnOverride: 'https://k@local.test/9' }, DSN)).toEqual({ dsn: 'https://k@local.test/9', release: 'kestrel@1.2.3', environment: 'development' });
  });
});

describe('sanitizeCrashReportPrefs', () => {
  test('is on unless it was switched off', () => {
    expect(sanitizeCrashReportPrefs(null)).toEqual({ enabled: true });
    expect(sanitizeCrashReportPrefs({ enabled: 'no' })).toEqual({ enabled: true });
    expect(sanitizeCrashReportPrefs({ enabled: false })).toEqual({ enabled: false });
  });
});

describe('scrubbing', () => {
  test('replaces the home folder wherever a path appears', () => {
    expect(scrubHome('ENOENT: /Users/someone/Code/app/file.ts and /Users/someone/.kestrel', '/Users/someone')).toBe('ENOENT: ~/Code/app/file.ts and ~/.kestrel');
  });

  test('replaces another user folder too, when the home folder is not known', () => {
    expect(scrubHome('at /Users/user/x.js:1 and /home/user/y', undefined)).toBe('at ~/x.js:1 and ~/y');
  });

  test('drops what could identify the user and keeps only system and runtime context', () => {
    const event = {
      message: 'failed in /Users/someone/Code/secret-project/a.ts',
      user: { ip_address: '10.0.0.1' },
      request: { url: 'app://kestrel/#/session/abc' },
      breadcrumbs: [{ message: 'console: my prompt' }],
      server_name: 'sams-macbook',
      extra: { arguments: ['x'] },
      contexts: { os: { name: 'macOS' }, runtime: { name: 'node' }, device: { name: 'Sam’s Mac' }, culture: { timezone: 'Europe/Paris' } },
      exception: { values: [{ value: 'boom', stacktrace: { frames: [{ filename: '/Users/someone/Applications/Kestrel.app/server/index.mjs' }] } }] },
    };
    const scrubbed = scrubReport(event, '/Users/someone');
    expect(scrubbed).toEqual({
      message: 'failed in ~/Code/secret-project/a.ts',
      contexts: { os: { name: 'macOS' }, runtime: { name: 'node' } },
      exception: { values: [{ value: 'boom', stacktrace: { frames: [{ filename: '~/Applications/Kestrel.app/server/index.mjs' }] } }] },
    });
  });

  test('leaves the report it was given untouched', () => {
    const event = { message: '/Users/someone/x', user: { id: '1' } };
    scrubReport(event, '/Users/someone');
    expect(event).toEqual({ message: '/Users/someone/x', user: { id: '1' } });
  });
});

describe('the stored switch and its route', () => {
  const none = async () => ({});

  test('is on by default and says how this copy reports', async () => {
    const reports = new CrashReports();
    const setup = { dsn: DSN, release: 'kestrel@1.2.3', environment: 'production' as const };
    expect(await crashReportsRoute(['api', 'crash-reports'], 'GET', none, reports, setup)).toEqual({ status: 200, body: { enabled: true, reporting: setup } });
  });

  test('switching it off is stored and takes effect at once', async () => {
    const settings = memorySettings();
    const reports = new CrashReports({ settings });
    const answer = await crashReportsRoute(['api', 'crash-reports'], 'PATCH', async () => ({ enabled: false }), reports, null);
    expect(answer).toEqual({ status: 200, body: { enabled: false, reporting: null } });
    expect(reports.current()).toEqual({ enabled: false });
    expect(await new CrashReports({ settings }).prefs()).toEqual({ enabled: false });
  });

  test('refuses anything but true or false, with the reason', async () => {
    const answer = await crashReportsRoute(['api', 'crash-reports'], 'PATCH', async () => ({ enabled: 'off' }), new CrashReports(), null);
    expect(answer).toEqual({ status: 400, body: { error: 'enabled must be true or false.' } });
  });

  test('an unreadable stored value falls back to on', async () => {
    const settings = memorySettings();
    await settings.putSetting(CRASH_REPORTS_KEY, '{not json');
    expect(await new CrashReports({ settings }).prefs()).toEqual({ enabled: true });
  });

  test('leaves other routes alone', async () => {
    expect(await crashReportsRoute(['api', 'commit-signing'], 'GET', none, new CrashReports(), null)).toBeNull();
  });
});
