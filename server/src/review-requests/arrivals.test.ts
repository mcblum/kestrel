// Whether a request is news depends on how it arrived (arrivals.ts), as the store applies it: one
// already satisfied when it arrives is read, one that stops being satisfied becomes unread, and an
// approval arriving later changes nothing either way.
import { describe, expect, it } from 'vitest';
import type { OthersReviews } from '../shared/others-said.ts';
import type { ReviewRequest } from '../shared/review-requests.ts';
import { ready, unavailable } from '../shared/sourced.ts';
import { arrive, asReviewArrivals, NO_ARRIVALS, type ReviewArrivals } from './arrivals.ts';
import { ReviewRequestStore } from './store.ts';

const SATISFIED: OthersReviews = { approvedBy: ['dana', 'lee'], changesRequestedBy: [], satisfied: true };
const ONE_APPROVAL: OthersReviews = { approvedBy: ['dana'], changesRequestedBy: [], satisfied: false };
const NOTHING: OthersReviews = { approvedBy: [], changesRequestedBy: [], satisfied: false };

const request = (number: number, others?: OthersReviews): ReviewRequest => ({
  key: `github.com/acme/app/${number}`,
  host: 'github',
  hostName: 'github.com',
  repository: 'acme/app',
  number,
  title: `Request ${number}`,
  author: 'sam',
  url: '',
  updatedAt: number,
  projectId: null,
  ...(others ? { others } : {}),
});

/** A store whose record was stored before (empty), so arrivals are applied from the first answer. */
function harness(arrivals: ReviewArrivals | null = NO_ARRIVALS) {
  const saved: { arrivals: ReviewArrivals | null; seen: readonly string[] } = { arrivals: null, seen: [] };
  const store = new ReviewRequestStore({ arrivals, saveArrivals: (a) => (saved.arrivals = a), saveSeen: (k) => (saved.seen = k) });
  const answer = (...requests: ReviewRequest[]) => store.set('github.com', ready(requests));
  return { store, saved, answer, unread: () => store.view().unread };
}

describe('how a request arrived decides whether it is new', () => {
  it('lists a request that is already satisfied when it arrives, but not as new', () => {
    const h = harness();
    h.answer(request(1, SATISFIED));
    expect(h.store.view().requests.map((r) => r.number)).toEqual([1]);
    expect(h.unread()).toEqual([]);
  });

  it('a request that arrives with approvals that do not satisfy the host is new as usual', () => {
    const h = harness();
    h.answer(request(1, ONE_APPROVAL), request(2));
    expect(h.unread()).toEqual([request(1).key, request(2).key]);
  });

  it('a request satisfied on arrival becomes unread the moment it stops being satisfied', () => {
    const h = harness();
    h.answer(request(1, SATISFIED));
    h.answer(request(1, SATISFIED));
    expect(h.unread()).toEqual([]);
    h.answer(request(1, NOTHING)); // the approvals were dismissed by a push
    expect(h.unread()).toEqual([request(1).key]);
    // And it is an ordinary unread request from then on: satisfied again, it stays unread.
    h.answer(request(1, SATISFIED));
    expect(h.unread()).toEqual([request(1).key]);
  });

  it('an approval arriving never makes a request unread again', () => {
    const h = harness();
    h.answer(request(1));
    h.store.markSeen([request(1).key], true);
    h.answer(request(1, ONE_APPROVAL));
    h.answer(request(1, SATISFIED));
    expect(h.unread()).toEqual([]);
  });

  it('an approval arriving does not mark an unread request read', () => {
    const h = harness();
    h.answer(request(1));
    h.answer(request(1, SATISFIED));
    expect(h.unread()).toEqual([request(1).key]);
  });

  it('a request whose others could not be read keeps its state: only the host’s word wakes it', () => {
    const h = harness();
    h.answer(request(1, SATISFIED));
    h.answer(request(1));
    expect(h.unread()).toEqual([]);
    h.store.set('github.com', unavailable('gh is down'));
    expect(h.unread()).toEqual([]);
  });

  it('keeps the record, so a restart does not take every request as arriving anew', () => {
    const h = harness();
    h.answer(request(1, SATISFIED), request(2));
    expect(h.saved.arrivals).toEqual({ known: [request(1).key, request(2).key], quiet: [request(1).key] });
    const again = harness(h.saved.arrivals);
    again.store.markSeen([request(1).key], true); // as the stored read keys would have it
    again.answer(request(1, NOTHING), request(2, SATISFIED));
    expect(again.unread()).toEqual([request(1).key, request(2).key]);
  });

  it('with no record stored yet, the first answer is only learned: nothing unread is read by turning this on', () => {
    const h = harness(null);
    h.answer(request(1, SATISFIED));
    expect(h.unread()).toEqual([request(1).key]);
    h.answer(request(1, SATISFIED), request(2, SATISFIED));
    expect(h.unread()).toEqual([request(1).key]);
  });
});

describe('the record', () => {
  it('returns the same objects when nothing changed', () => {
    const arrivals = { known: ['a'], quiet: [] };
    const seen = ['a'];
    const step = arrive(arrivals, seen, [{ key: 'a', others: SATISFIED }]);
    expect(step.arrivals).toBe(arrivals);
    expect(step.seen).toBe(seen);
  });

  it('reads a stored record, and anything else as none', () => {
    expect(asReviewArrivals({ known: ['a', 'a'], quiet: ['a'] })).toEqual({ known: ['a'], quiet: ['a'] });
    expect(asReviewArrivals({ known: 'a', quiet: [] })).toBeNull();
    expect(asReviewArrivals(null)).toBeNull();
  });
});
