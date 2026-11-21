// The server's crash reporter: Sentry's Node SDK pointed at Kestrel's GlitchTip. Started once, at
// launch, only when this copy reports at all (shared/crash-reports.ts: the installed app, with an
// address). The SDK is loaded only then, so a checkout never loads it.
//
// It is set up to see failures and nothing else: no default integrations (no console, HTTP or
// module capture, no tracing) and no breadcrumbs. Every report goes through
// `scrubReport`, and the switch is asked for each one, so turning it off takes effect at once.
//
// An uncaught error still ends the server as it always did; the reporter only waits (two seconds
// at most) for the report to leave first.
import { homedir } from 'node:os';
import { scrubReport, type CrashReportSetup } from '../shared/crash-reports.ts';

export interface CrashReporter {
  /** Report a failure Kestrel caught itself. */
  report(error: unknown): void;
  /** Send one test report, to check the path end to end (KESTREL_TEST_CRASH_REPORT=1). */
  sendTest(): Promise<boolean>;
}

const FLUSH_MS = 2000;

export async function startCrashReporter(setup: CrashReportSetup, isEnabled: () => boolean): Promise<CrashReporter> {
  const Sentry = await import('@sentry/node');
  const home = homedir();
  Sentry.init({
    dsn: setup.dsn,
    release: setup.release,
    environment: setup.environment,
    defaultIntegrations: false,
    integrations: [Sentry.onUncaughtExceptionIntegration(), Sentry.onUnhandledRejectionIntegration({ mode: 'strict' }), Sentry.linkedErrorsIntegration(), Sentry.dedupeIntegration()],
    maxBreadcrumbs: 0,
    tracesSampleRate: 0,
    serverName: 'kestrel',
    initialScope: { tags: { part: 'server' } },
    beforeSend: (event) => (isEnabled() ? scrubReport(event as unknown as Record<string, unknown>, home) as unknown as typeof event : null),
  });
  return {
    report: (error) => void Sentry.captureException(error),
    sendTest: async () => {
      Sentry.captureException(new Error('Kestrel test crash report (server)'));
      return Sentry.flush(FLUSH_MS);
    },
  };
}
