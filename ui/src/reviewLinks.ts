// Getting from the review of a session's own work to the reviewer's conversation, and acting on the
// card that stays when the review ended with findings open (server: shared/round-findings.ts,
// review-end.ts). Opening the review is the app's own way of opening a session, with a request to
// land on the reviewer's message the findings came from.
import type { ReviewEnd } from '@kestrel/server/round-findings';
import { openSession } from './route.ts';
import { act, call, messageFocus } from './store.ts';
import { toasts } from './toasts.ts';

/** Open the reviewer's session, at its message `at` when given. */
export function openReview(reviewerId: string, at: string | undefined, newTab = false): void {
  if (at) messageFocus.set(reviewerId, at);
  openSession(reviewerId, newTab);
}

/** What "Open the review" says, wherever it is offered. */
export const OPEN_REVIEW = 'Open the review';

type EndAction = 'fix' | 'close' | 'reopen';

async function endAction(sessionId: string, cardId: string, action: EndAction, findingIds: readonly string[] = []): Promise<boolean> {
  const done = await act(() => call<{ reviewEnd: ReviewEnd }>(`/api/sessions/${encodeURIComponent(sessionId)}/review-end`, { method: 'POST', body: JSON.stringify({ cardId, action, findingIds }) }).then(() => true));
  return done === true;
}

export const reviewEndActions = {
  /** Ask the author, in one message, to fix the findings chosen. */
  fix: (sessionId: string, cardId: string, findingIds: readonly string[]) => endAction(sessionId, cardId, 'fix', findingIds),
  /** Carry on: the card leaves the foot of the conversation. Said in a toast, with Undo. */
  async close(sessionId: string, cardId: string): Promise<void> {
    if (await endAction(sessionId, cardId, 'close')) toasts.show('Review findings put away. They stay on the round cards.', () => void endAction(sessionId, cardId, 'reopen'));
  },
  /** Bring the card back above the message box. */
  reopen: (sessionId: string, cardId: string) => endAction(sessionId, cardId, 'reopen'),
};
