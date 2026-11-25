// Whether a request is news depends on how it arrived (Matt, 2026-11-25). A request that is already
// satisfied when it first arrives (the host says it has every approval it needs) is listed but read:
// nobody needs the user. One that arrives with approvals that do not satisfy the host is new as
// usual. One that was satisfied on arrival and later stops being satisfied (an approval dismissed
// after a push, a reviewer who asks for changes) becomes unread at that moment. An approval arriving
// on a request already listed changes nothing: it never makes it unread again, and never marks an
// unread one read.
//
// So the store remembers which keys it has listed (`known`) and which of those were read because
// they arrived satisfied (`quiet`). Both are kept with the app's settings, so a restart does not
// take every request as arriving anew. Pure.
import { isSatisfied } from '../shared/others-said.ts';
import { withDismissed, type ReviewRequest } from '../shared/review-requests.ts';

export interface ReviewArrivals {
  /** Every request key the store has listed. */
  known: string[];
  /** The keys read only because they were satisfied when they arrived. */
  quiet: string[];
}

export const NO_ARRIVALS: ReviewArrivals = { known: [], quiet: [] };

const isKeys = (value: unknown): value is string[] => Array.isArray(value) && value.every((k) => typeof k === 'string' && k.length > 0 && k.length <= 300);

/** A stored record, checked: whatever is not one reads as null, as if none were stored. */
export function asReviewArrivals(raw: unknown): ReviewArrivals | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  return isKeys(r.known) && isKeys(r.quiet) ? { known: withDismissed([], r.known, true), quiet: withDismissed([], r.quiet, true) } : null;
}

export interface ArrivalStep {
  arrivals: ReviewArrivals;
  /** The read keys afterwards. */
  seen: readonly string[];
}

/**
 * One host's answer applied to what is known and read. `seeding` is for the first answer after the
 * record was never stored: what is listed then is only learned, so turning this on reads nothing
 * that was unread. Returns the same objects when nothing changed. Pure.
 */
export function arrive(arrivals: ReviewArrivals, seen: readonly string[], requests: readonly Pick<ReviewRequest, 'key' | 'others'>[], seeding = false): ArrivalStep {
  const known = new Set(arrivals.known);
  const quiet = new Set(arrivals.quiet);
  const read = new Set(seen);
  const learned: string[] = [];
  const quieted: string[] = [];
  const woken: string[] = [];
  for (const request of requests) {
    if (!known.has(request.key)) {
      learned.push(request.key);
      known.add(request.key);
      if (!seeding && isSatisfied(request) && !read.has(request.key)) quieted.push(request.key);
    } else if (quiet.has(request.key) && request.others && !request.others.satisfied) {
      // Only a host's answer says it stopped: a request whose others could not be read keeps its state.
      woken.push(request.key);
    }
  }
  if (learned.length === 0 && woken.length === 0) return { arrivals, seen };
  const nextQuiet = withDismissed(withDismissed(arrivals.quiet, quieted, true), woken, false);
  const nextSeen = woken.length || quieted.length ? withDismissed(withDismissed(seen, quieted, true), woken, false) : seen;
  return { arrivals: { known: withDismissed(arrivals.known, learned, true), quiet: nextQuiet }, seen: nextSeen };
}
