// A review of a session's work by the Review role's agent (server: shared/worktree-guests.ts,
// delegation.ts `startReview`): where it stands, held once in the app store per session, and
// starting one. "Don't ask again for this session" is remembered in this browser.
import type { Review } from '@kestrel/server/worktree-guests';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { useResource } from './data/resources.ts';
import type { ModelPreset } from '@kestrel/server/who-does-what';
import { openSession } from './route.ts';
import { actions, appStore, call, putResource } from './store.ts';
import { tabActions } from './tabsStore.ts';

const pathOf = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/review`;
/** Where a session's review stands, and who would review its work now (or why nobody can). */
export interface ReviewState {
  review: Review | null;
  reviewer: ModelPreset | null;
  reason: string;
}
const NOTHING: ReviewState = { review: null, reviewer: null, reason: '' };
const asState = (raw: unknown): Sourced<ReviewState> => ready({ ...NOTHING, ...(raw as Partial<ReviewState>) });

/** Where the session's review stands and who would review it; nothing until the server has answered. */
export function useReview(sessionId: string): ReviewState {
  const loaded = useResource(pathOf(sessionId), asState).value;
  return loaded.state === 'ready' ? loaded.value : NOTHING;
}

/** Start a review; throws with the server's reason when it cannot. */
export async function startReview(sessionId: string, comment = false): Promise<Review> {
  // `comment`: post how it ends to the session's pull request ("Open PR and start review").
  const { review } = await call<{ review: Review }>(pathOf(sessionId), { method: 'POST', body: JSON.stringify({ comment }) });
  const held = appStore.get().resources.get(pathOf(sessionId)) as Sourced<ReviewState> | undefined;
  putResource(pathOf(sessionId), ready({ ...(held?.state === 'ready' ? held.value : NOTHING), review }));
  return review;
}

const startingRequests = new Map<string, Promise<void>>();

/** Start an assigned review and open its session, from the inbox or the request page. */
export function startRequestedReview(key: string, newTab: boolean): Promise<void> {
  const pending = startingRequests.get(key);
  if (pending) return pending;
  const start = actions.startReview(key).then((session) => {
    if (!session) return;
    tabActions.expect(session.id);
    openSession(session.id, newTab);
  }).finally(() => startingRequests.delete(key));
  startingRequests.set(key, start);
  return start;
}

const SKIPPED = 'kestrel.reviewSkipped';
const MAX_REMEMBERED = 200;

function skipped(): string[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(SKIPPED) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Whether the user chose "Don't ask again for this session" here. */
export const reviewSkippedFor = (sessionId: string): boolean => skipped().includes(sessionId);

export function skipReviewFor(sessionId: string): void {
  try {
    window.localStorage.setItem(SKIPPED, JSON.stringify([...skipped().filter((id) => id !== sessionId), sessionId].slice(-MAX_REMEMBERED)));
  } catch {
    // Not remembered: it is asked again next time, which is the safe side.
  }
}

/** Start a role's part by hand, from what was typed in a session's message box (server: delegation.ts `startRole`). */
export const startRole = (sessionId: string, role: 'design' | 'build', brief: string): Promise<unknown> => call(`/api/sessions/${encodeURIComponent(sessionId)}/role`, { method: 'POST', body: JSON.stringify({ role, brief }) });
