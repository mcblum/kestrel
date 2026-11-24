// The Start review button of a request the user was asked to review, for the window's route and a phone of
// the account alike (kestrel-connect.md, "Actions"): one function, so both restore the request, mark it read
// and start (or give back) its review the same way, with the same refusals.
import type { Session } from '../model.ts';
import { Refused } from '../refused.ts';
import type { ReviewRequest } from '../shared/review-requests.ts';
import type { StartReviewOptions } from './start.ts';
import type { ReviewRequestStore } from './store.ts';

export async function startRequestedReview(store: Pick<ReviewRequestStore, 'view' | 'dismiss' | 'markSeen'>, startReview: (request: ReviewRequest, opts: StartReviewOptions) => Promise<Session>, key: string, opts: StartReviewOptions = {}): Promise<Session> {
  const held = store.view();
  // Starting a review of a dismissed request restores it: it waits on the user again.
  const request = held.requests.find((r) => r.key === key) ?? held.dismissed.find((r) => r.key === key);
  if (!request) throw new Refused('This review is no longer waiting on you: it was reviewed, merged, closed, or the request was taken back.');
  store.dismiss([key], false);
  store.markSeen([key], true);
  return startReview(request, opts);
}
