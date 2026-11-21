// The CODE REVIEWS rows: who asked for each review (requester.ts), what a row says and the order
// rows are drawn in (shared/review-requests.ts), pinned requests (shared/pinned-homes.ts), and the
// code a review comment points at (shared/code-excerpt.ts).
import { describe, expect, it } from 'vitest';
import type { TreeNode } from '../model.ts';
import { excerptAround, extensionOf } from '../shared/code-excerpt.ts';
import { sidebarHomes } from '../shared/pinned-homes.ts';
import { visiblePins } from '../shared/pins.ts';
import { asReviewOrder, asReviewRequestsView, inSidebarOrder, placeReview, requestStatus, reviewRowDetail, type FoundReviewRequest } from '../shared/review-requests.ts';
import { ready } from '../shared/sourced.ts';
import { githubRequester, gitlabRequester, withRequesters } from './requester.ts';
import { ReviewRequestStore } from './store.ts';

const found = (number: number, over: Partial<FoundReviewRequest> = {}): FoundReviewRequest => ({ host: 'github', hostName: 'github.com', repository: 'acme/storefront', number, title: `Request ${number}`, author: 'priya', url: '', updatedAt: number, ...over });

describe('who asked for a review', () => {
  it('reads the last request made of the user by name from a GitHub timeline', () => {
    const timeline = JSON.stringify([
      { event: 'review_requested', review_requester: { login: 'sam' }, requested_reviewer: { login: 'Matt' } },
      { event: 'review_requested', review_requester: { login: 'lee' }, requested_team: { name: 'core' } },
      { event: 'review_requested', review_requester: { login: 'ana' }, requested_reviewer: { login: 'someone-else' } },
      { event: 'review_requested', review_requester: { login: 'kim' }, requested_reviewer: { login: 'matt' } },
    ]);
    expect(githubRequester(timeline, 'matt')).toBe('kim');
    expect(githubRequester('[]', 'matt')).toBeNull();
  });

  it('reads it from the newest GitLab system note that names the user', () => {
    const notes = JSON.stringify([
      { system: false, body: 'requested review from @matt', author: { username: 'joker' } },
      { system: true, body: 'requested review from @matthew', author: { username: 'wrong' } },
      { system: true, body: 'requested review from @ana and @matt', author: { username: 'kim' } },
      { system: true, body: 'requested review from @matt', author: { username: 'older' } },
    ]);
    expect(gitlabRequester(notes, 'matt')).toBe('kim');
    expect(gitlabRequester('[]', 'matt')).toBeNull();
  });

  it('asks about a request once, and again only when it changed or the ask failed', async () => {
    const asked: number[] = [];
    let fail = true;
    const add = withRequesters(async (r) => {
      asked.push(r.number);
      if (r.number === 2 && fail) throw new Error('offline');
      return r.number === 1 ? 'kim' : null;
    });
    expect((await add([found(1), found(2), found(3)])).map((r) => r.requestedBy)).toEqual(['kim', undefined, undefined]);
    fail = false;
    await add([found(1), found(2), found(3)]);
    await add([found(1, { updatedAt: 99 }), found(2), found(3)]);
    expect(asked).toEqual([1, 2, 3, 2, 1]);
  });
});

describe('what a review row says', () => {
  it('names the project when there is one, else the repository, then who asked', () => {
    expect(reviewRowDetail(found(412, { requestedBy: 'kim' }), 'Bellbird')).toBe('Bellbird #412 · kim');
    expect(reviewRowDetail(found(412, { requestedBy: 'kim' }))).toBe('storefront #412 · kim');
  });

  it('names the author when the host did not say who asked', () => {
    expect(reviewRowDetail(found(412))).toBe('storefront #412 · priya');
  });

  it('has a status for every request with no review yet', () => {
    expect(requestStatus({})).toEqual({ tone: 'idle', label: 'No review started' });
    expect(requestStatus({ notStarted: 'No agent is connected.' })).toMatchObject({ tone: 'needs-you', label: expect.stringContaining('No agent is connected.') });
  });
});

describe('the order of the rows', () => {
  const rows = [{ key: 'c' }, { key: 'b' }, { key: 'a' }];

  it('is as pushed when sessions are sorted by most recent', () => {
    expect(inSidebarOrder(rows, ['a', 'b', 'c'], false).map((r) => r.key)).toEqual(['c', 'b', 'a']);
  });

  it('follows the dragged order, with a request not placed yet first', () => {
    expect(inSidebarOrder(rows, ['a', 'b'], true).map((r) => r.key)).toEqual(['c', 'a', 'b']);
  });

  it('puts a dragged row before or after the one it was dropped on', () => {
    expect(placeReview(['a', 'b', 'c'], 'c', 'a', false)).toEqual(['c', 'a', 'b']);
    expect(placeReview(['a', 'b', 'c'], 'a', 'b', true)).toEqual(['b', 'a', 'c']);
  });

  it('is kept by the store, pushed with the list, and saved', () => {
    const saved: string[][] = [];
    const store = new ReviewRequestStore({ order: ['x'], saveOrder: (order) => saved.push([...order]) });
    expect(store.view().order).toEqual(['x']);
    store.set('github.com', ready([]));
    store.setOrder(['b', 'a']);
    expect(store.view().order).toEqual(['b', 'a']);
    expect(saved).toEqual([['b', 'a']]);
  });

  it('accepts only a list of keys, and reads an older server as no order', () => {
    expect(asReviewOrder(['a', 'a', 'b'])).toEqual(['a', 'b']);
    expect(asReviewOrder('a')).toBeNull();
    expect(asReviewRequestsView({ requests: [], problems: [] }).order).toEqual([]);
  });
});

describe('a pinned review request', () => {
  const node = (sessionId: string): TreeNode => ({ sessionId, via: null, movedFrom: null, children: [] });
  const session = (id: string) => ({ id, filing: { projectId: null, status: 'unscoped' as const } });
  const base = { trees: { ungrouped: [node('s1'), node('s2')] }, sessions: [session('s1'), session('s2')] };

  it('is always kept among the pins: the sidebar decides whether it is still listed', () => {
    const pins = [{ kind: 'review' as const, id: 'k', pinnedAt: 1 }];
    expect(visiblePins(pins, { sessions: new Set(), projects: new Set(), groups: new Set() })).toEqual(pins);
  });

  it('with no review yet is a request row under PINNED', () => {
    const homes = sidebarHomes({ ...base, pins: [{ kind: 'review', id: 'k' }], listedReviews: new Set(['k']) });
    expect(homes.pinned).toEqual([{ kind: 'review', id: 'k' }]);
  });

  it('is not drawn once its request is no longer listed', () => {
    expect(sidebarHomes({ ...base, pins: [{ kind: 'review', id: 'k' }], listedReviews: new Set() }).pinned).toEqual([]);
  });

  it('with a review session is that session, under PINNED and nowhere else', () => {
    const homes = sidebarHomes({ ...base, pins: [{ kind: 'review', id: 'k' }], listedReviews: new Set(['k']), reviewing: new Set(['s1']), reviewKeyOf: new Map([['s1', 'k']]) });
    expect(homes.pinned).toEqual([{ kind: 'review', id: 'k', node: node('s1') }]);
    expect(homes.reviews).toEqual([]);
    expect(homes.trees.ungrouped!.map((n) => n.sessionId)).toEqual(['s2']);
  });

  it('is drawn once when its session is pinned too', () => {
    const homes = sidebarHomes({ ...base, pins: [{ kind: 'session', id: 's1' }, { kind: 'review', id: 'k' }], listedReviews: new Set(['k']), reviewing: new Set(['s1']), reviewKeyOf: new Map([['s1', 'k']]) });
    expect(homes.pinned.map((row) => row.kind)).toEqual(['session']);
  });
});

describe('the code a comment points at', () => {
  const text = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

  it('shows the line with lines around it, and says where it is among them', () => {
    const excerpt = excerptAround(text, 12, 2);
    expect(excerpt).toEqual({ code: 'line 10\nline 11\nline 12\nline 13\nline 14', first: 10, marked: 2, total: 30 });
  });

  it('stops at the ends of the file', () => {
    expect(excerptAround(text, 1, 2)).toMatchObject({ first: 1, marked: 0, code: 'line 1\nline 2\nline 3' });
    expect(excerptAround(text, 30, 2)).toMatchObject({ first: 28, marked: 2 });
  });

  it('shows the whole file when asked, or when the line is not in it', () => {
    expect(excerptAround(text, 12, null)).toMatchObject({ first: 1, marked: 11, total: 30 });
    expect(excerptAround(text, 99)).toMatchObject({ first: 1, marked: null, total: 30 });
  });

  it('takes the language from the file name', () => {
    expect(extensionOf('ui/src/Table.test.tsx')).toBe('tsx');
    expect(extensionOf('Makefile')).toBeNull();
    expect(extensionOf('.gitignore')).toBeNull();
  });
});
