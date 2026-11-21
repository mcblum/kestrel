// Settings → General → Crash reports (server: shared/crash-reports.ts, crash-reports/). On by
// default. Held once in the app store through useResource, like "Keep awake"; a change writes
// back what the server stored. `useCrashReporting` is the same answer put to work: called once by
// the app, it starts the page's reporter and makes it follow the switch (crashReports.ts).
import { useEffect } from 'react';
import type { CrashReportStatus } from '@kestrel/server/crash-reports';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { applyCrashReporting } from '../crashReports.ts';
import { useResource } from '../data/resources.ts';
import { act, call, OLDER_SERVER, putResource, RESTART_REASON } from '../store.ts';
import { SettingSection } from './SettingHelp.tsx';

export const CRASH_REPORTS_PATH = '/api/crash-reports';
const asStatus = (raw: unknown): Sourced<CrashReportStatus> => ready(raw as CrashReportStatus);

/** Keeps the page's reporter in step with the stored switch, once the server can be asked. */
export function useCrashReporting(serverReady: boolean): void {
  const loaded = useResource(serverReady ? CRASH_REPORTS_PATH : null, asStatus).value;
  const status = loaded.state === 'ready' ? loaded.value : null;
  useEffect(() => {
    if (status) applyCrashReporting(status);
  }, [status]);
}

function Controls() {
  const loaded = useResource(CRASH_REPORTS_PATH, asStatus).value;
  if (loaded.state !== 'ready') return <p className="settings-help">{loaded.state === 'loading' ? 'Loading…' : loaded.reason === RESTART_REASON ? OLDER_SERVER : loaded.reason}</p>;
  const status = loaded.value;
  const change = async (enabled: boolean) => {
    const next = await act(() => call<CrashReportStatus>(CRASH_REPORTS_PATH, { method: 'PATCH', body: JSON.stringify({ enabled }) }));
    if (next) putResource(CRASH_REPORTS_PATH, ready(next));
  };
  return (
    <>
      <label className="tag-rule-switch">
        <input type="checkbox" checked={status.enabled} onChange={(e) => void change(e.target.checked)} />
        Send a report when Kestrel fails
      </label>
      {!status.reporting && <p className="settings-help" role="status">This copy of Kestrel never sends reports: only the installed app does.</p>}
    </>
  );
}

const HELP = (
  <p className="settings-help">
    When Kestrel itself fails, it sends the error and where in Kestrel's code it happened, with the Kestrel version, so the problem can be fixed. A report never includes your conversations, your code, file contents, project names or
    your name, and the path to your home folder is removed. Nothing is recorded about what you were doing before the failure. On unless you turn it off.
  </p>
);

export function CrashReportsSetting() {
  return (
    <SettingSection title="Crash reports" help={HELP}>
      <Controls />
    </SettingSection>
  );
}
