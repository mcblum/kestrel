// Answers to optional actions (server: suggestions/api.ts). The card itself arrives on the session's
// live channel like any message, so these only send the answer; a refusal shows in the error line.
import type { RuleRow, RuleValue } from '@kestrel/server/tag-rules';
import type { AnswerSource, StandingAnswer, TicketAnswer, TicketChange } from '@kestrel/server/ticket-changes';
import { ARCHIVE_KIND } from '@kestrel/server/archive-approved';
import type { Suggestion } from '@kestrel/server/suggestions';
import { act, actions, appStore, call } from './store.ts';
import { toasts } from './toasts.ts';

const path = (sessionId: string, suggestionId: string, action: string) => `/api/sessions/${encodeURIComponent(sessionId)}/suggestions/${encodeURIComponent(suggestionId)}/${action}`;

export const suggestionActions = {
  answer: async (sessionId: string, suggestionId: string, button: string) => {
    const title = appStore.get().sessionsById.get(sessionId)?.title;
    const answered = await act(() => call<{ suggestion: Suggestion }>(path(sessionId, suggestionId, 'answer'), { method: 'POST', body: JSON.stringify({ button }) }));
    // The archive offer archived the session: said as every archive is, with Undo, which restores it the same way.
    if (answered?.suggestion.kind === ARCHIVE_KIND && answered.suggestion.undo) toasts.show(`Archived ${title ? `“${title}”` : 'the session'}`, () => actions.archive('session', sessionId, false, false));
    return answered;
  },
  dismiss: (sessionId: string, suggestionId: string) => act(() => call(path(sessionId, suggestionId, 'dismiss'), { method: 'POST' })),
  undo: (sessionId: string, suggestionId: string) => act(() => call(path(sessionId, suggestionId, 'undo'), { method: 'POST' })),
};

export interface TagPrefsView {
  enabled: boolean;
  rules: RuleRow[];
}

export const TAG_PREFS_PATH = '/api/suggestion-prefs/tags';
const PREFS = TAG_PREFS_PATH;

export const changeTagPrefs = (change: { enabled?: boolean; rule?: { key: string; value: RuleValue } }) => act(() => call<TagPrefsView>(PREFS, { method: 'PATCH', body: JSON.stringify(change) }));

/** Settings → Tickets: the standing answers to ticket changes (server: suggestions/api.ts). */
export const TICKET_ANSWERS_PATH = '/api/suggestion-prefs/tickets';

export const setTicketAnswer = (change: TicketChange, source: AnswerSource, answer: StandingAnswer | 'ask') =>
  act(() => call<{ answers: TicketAnswer[] }>(TICKET_ANSWERS_PATH, { method: 'PATCH', body: JSON.stringify({ change, source, answer }) }));
