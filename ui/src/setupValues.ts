// Copying a set-up step's missing values from another computer (docs/designs/onboarding.md, section 19).
// This module owns the `setupValueRequests` slice, filled from the server's `setup-value-requests` push
// (setupSteps.ts hands the message on: one handler holds the `setup-` prefix). Nothing here ever holds a
// value: the copy route answers names, the request card shows names, and the record of what was sent
// holds names. Every action says what it did in a toast; a copy's Undo calls the server's own undo.
import { asSentList, sentText, type SentEntry, type ValueRequestView } from '@kestrel/server/setup-values';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { fetchResource } from './data/resources.ts';
import { asSetupList, SETUP_PATH } from './setupList.ts';
import { act, call, putResource, setApp, useApp } from './store.ts';
import { toasts } from './toasts.ts';

/** What a copy answered: names only. */
interface CopyReport {
  said: string;
  undo: string | null;
}

/** What an Allow answered: the names sent, for the toast. */
interface SentReport {
  to: string;
  step: string;
  sent: string[];
  notThere: string[];
}

export const SENT_PATH = `${SETUP_PATH}/sent`;

const isRequest = (r: unknown): r is ValueRequestView => {
  const v = r as Partial<ValueRequestView> | null;
  return !!v && typeof v.id === 'string' && typeof v.step === 'string' && Array.isArray(v.names) && typeof v.expiresAt === 'number' && typeof v.from?.name === 'string';
};

/** The server's push (or the answer to asking for it), checked for shape. */
export function putValueRequests(raw: unknown): void {
  if (Array.isArray(raw)) setApp({ setupValueRequests: raw.filter(isRequest) });
}

/** Asked for when the socket opens. */
export const askValueRequests = (): Promise<void> => call<unknown>(`${SETUP_PATH}/value-requests`).then(putValueRequests, () => undefined);

export const useValueRequests = (): readonly ValueRequestView[] => useApp((s) => s.setupValueRequests);

/** GET …/sent, checked: anything malformed is dropped (asSentList). */
export const asSent = (raw: unknown): Sourced<SentEntry[]> => ready(asSentList(raw));

const post = <T>(part: string, body: unknown) => call<T>(`${SETUP_PATH}/${part}`, { method: 'POST', body: JSON.stringify(body) });
const refreshList = () => fetchResource(SETUP_PATH, asSetupList, true);
const refreshSent = () => fetchResource(SENT_PATH, asSent, true);

/** The Allow toast: what was sent, by name (sentText), or that this computer had none of them. */
const allowedText = (report: SentReport): string => (report.sent.length > 0 ? sentText(report.sent, report.to, report.step) : `Nothing was sent to ${report.to}: this computer has none of them.`);

export const setupValues = {
  /** The Copy values button: the server asks the other computer and writes what comes back; the page sees names. */
  copy: async (line: string, from: string) => {
    const report = await act(() => post<CopyReport>('copy', { line, from }));
    if (!report) return;
    const token = report.undo;
    toasts.show(report.said, token ? () => void act(() => post('undo', { token })).then(refreshList) : undefined);
    await refreshList();
  },
  /** Allow or Deny on the request card. Nothing to undo: what was sent is gone (a toast says what was done). */
  answer: async (id: string, allow: boolean, from: string) => {
    const answer = await act(() => post<{ sent: SentReport | null }>(`value-requests/${encodeURIComponent(id)}`, { allow }));
    if (!answer) return;
    toasts.show(answer.sent ? allowedText(answer.sent) : `Told ${from} no.`);
    if (answer.sent) await refreshSent();
  },
  /** Clear on Settings → Connections' list; Undo puts it back as it was. */
  clearSent: async () => {
    const answer = await act(() => call<{ undo: string }>(SENT_PATH, { method: 'DELETE' }));
    if (!answer) return;
    putResource(SENT_PATH, ready([]));
    toasts.show('Cleared the list of values copied to other computers', () =>
      void act(() => post<unknown>('sent/restore', { token: answer.undo })).then((list) => list !== undefined && putResource(SENT_PATH, asSent(list))),
    );
  },
};
