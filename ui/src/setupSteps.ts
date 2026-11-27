// Set up this computer's actions outside React (docs/designs/onboarding.md, section 18). Runs are the
// store's `setupRuns` slice (this module owns the writes), filled from the server's `setup-runs` push;
// the list itself is the route's resource (setupList.ts), replaced with the answer to a dismissal and
// asked again after a run. Every action says what it did in a toast, with Undo where the server can put it
// back; Undo calls the same route the other way.
import type { SetupGroup, SetupList } from '@kestrel/server/setup-list';
import type { SetupRuns } from '@kestrel/server/setup-sections';
import { fetchResource } from './data/resources.ts';
import { asSetupList, SETUP_PATH } from './setupList.ts';
import { act, call, putResource, setApp, setupSocket, useApp } from './store.ts';
import { askValueRequests, putValueRequests } from './setupValues.ts';
import { toasts } from './toasts.ts';
import { refreshWhoDoesWhat } from './whoDoesWhat.ts';

interface RunReport {
  done: string[];
  waiting: string[];
  failed: string[];
  also: string[];
  undo: string | null;
}

const put = (runs: SetupRuns | undefined) => {
  if (runs && typeof runs === 'object') setApp({ setupRuns: runs });
};

setupSocket.register({
  message: (message) => {
    if (message.type === 'setup-runs') put(message.runs as SetupRuns);
    // Other computers' requests for values (setupValues.ts owns that slice): one handler holds the prefix.
    if (message.type === 'setup-value-requests') putValueRequests(message.requests);
  },
  opened: () => {
    void call<SetupRuns>(`${SETUP_PATH}/runs`).then(put, () => undefined);
    void askValueRequests();
  },
});

export const useSetupRuns = (): SetupRuns => useApp((s) => s.setupRuns);

const post = <T>(part: string, body: unknown) => call<T>(`${SETUP_PATH}/${part}`, { method: 'POST', body: JSON.stringify(body) });

/** The words of a run's toast: what was done, what waits, what failed, and what was run first. */
export function reportText(report: RunReport): string {
  const parts = [
    report.done.length > 0 && `Done: ${report.done.join(', ')}`,
    report.also.length > 0 && `(also ran ${report.also.join(', ')} first)`,
    report.waiting.length > 0 && `Waiting: ${report.waiting.join(', ')}`,
    report.failed.length > 0 && `Failed: ${report.failed.join(', ')}`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('. ') : 'Nothing was run';
}

// A step may change a setting the app holds (the model presets): asked again with the list, so every view shows it.
const refreshList = () => Promise.all([fetchResource(SETUP_PATH, asSetupList, true), refreshWhoDoesWhat()]).then(() => undefined);

async function afterRun(report: RunReport | undefined): Promise<void> {
  if (!report) return;
  const token = report.undo;
  toasts.show(reportText(report), token ? () => void act(() => post('undo', { token })).then(refreshList) : undefined);
  await refreshList();
}

export const setupSteps = {
  /** Runs one line, on its own click; `input` is what the person typed on it (a token), sent once. */
  runLine: async (line: string, input: Record<string, string> = {}) => afterRun(await act(() => post<RunReport>('run', { line, input }))),
  /** Runs a section, in need order (18.5). */
  runSection: async (section: SetupGroup) => afterRun(await act(() => post<RunReport>('run', { section }))),
  /** Dismisses or restores lines on this computer; announced, and Undo is the same action the other way. */
  dismiss: async (ids: string[], dismissed: boolean, title: string, quiet = false) => {
    const list = await act(() => post<SetupList>('dismiss', { ids, dismissed }));
    if (!list) return;
    putResource(SETUP_PATH, asSetupList(list));
    if (!quiet) toasts.show(`${dismissed ? 'Dismissed' : 'Restored'} ${title}`, () => void setupSteps.dismiss(ids, !dismissed, title, true));
  },
  /** The page was left: results from before go. */
  forget: () => void call(`${SETUP_PATH}/runs`, { method: 'DELETE' }).catch(() => undefined),
};
