// The page's crash reporter (server: shared/crash-reports.ts, crash-reports/). It reports the
// same way as the server and under the same switch: the server says how this copy reports (or
// that it never does), and Sentry's browser SDK is loaded only then, so a checkout and a plain
// browser never load it.
//
// It sees failures and nothing else: only the uncaught-error handlers are installed, with no
// breadcrumbs (no clicks, console lines or requests on the way to a failure), and every report
// goes through `scrubReport`, which also drops the page address.
import { scrubReport, type CrashReportStatus } from '@kestrel/server/crash-reports';

type Capture = (error: unknown) => void;

let enabled = false;
let starting = false;
let capture: Capture | null = null;

async function start(status: CrashReportStatus & { reporting: NonNullable<CrashReportStatus['reporting']> }): Promise<void> {
  const Sentry = await import('@sentry/browser');
  Sentry.init({
    dsn: status.reporting.dsn,
    release: status.reporting.release,
    environment: status.reporting.environment,
    defaultIntegrations: false,
    integrations: [Sentry.globalHandlersIntegration(), Sentry.linkedErrorsIntegration(), Sentry.dedupeIntegration()],
    maxBreadcrumbs: 0,
    tracesSampleRate: 0,
    initialScope: { tags: { part: 'page' } },
    beforeSend: (event) => (enabled ? (scrubReport(event as unknown as Record<string, unknown>, undefined) as unknown as typeof event) : null),
  });
  capture = (error) => void Sentry.captureException(error);
}

/** Follow what the server says: start reporting the first time it is on, and obey the switch after. */
export function applyCrashReporting(status: CrashReportStatus): void {
  enabled = status.enabled;
  if (!status.reporting || !enabled || starting) return;
  starting = true;
  void start({ ...status, reporting: status.reporting }).catch((error: unknown) => console.error('[kestrel] crash reports could not start', error));
}

/** Report a failure the page caught itself (the crash screen). Nothing happens when reporting is off. */
export function reportCrash(error: unknown): void {
  if (enabled) capture?.(error);
}
