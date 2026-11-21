// HTTP route for Settings → General → "Crash reports". Shaped like commit-signing/api.ts. Behind
// the same token, Origin and Host checks as every route; no Kestrel tool reaches it, so only the
// user changes it.
//
//   GET   /api/crash-reports                      200 { enabled, reporting }
//   PATCH /api/crash-reports  { enabled: boolean } 200 { enabled, reporting } | 400 { error }
//
// `reporting` is how this copy reports ({ dsn, release, environment }) or null when it never does
// (a checkout, or no address): the page reports the same way, and says so in Settings.
import type { CrashReportSetup, CrashReportStatus } from '../shared/crash-reports.ts';
import type { CrashReports } from './prefs.ts';

export type CrashReportsAnswer = { status: number; body: unknown };
type ReadBody = () => Promise<Record<string, unknown>>;

export async function crashReportsRoute(parts: readonly string[], method: string, readBody: ReadBody, reports: CrashReports, reporting: CrashReportSetup | null): Promise<CrashReportsAnswer | null> {
  if (parts[1] !== 'crash-reports' || parts.length !== 2) return null;
  const status = (prefs: { enabled: boolean }): CrashReportStatus => ({ ...prefs, reporting });
  if (method === 'GET') return { status: 200, body: status(await reports.prefs()) };
  if (method !== 'PATCH') return null;
  const body = await readBody();
  if (typeof body.enabled !== 'boolean') return { status: 400, body: { error: 'enabled must be true or false.' } };
  return { status: 200, body: status(await reports.setEnabled(body.enabled)) };
}
