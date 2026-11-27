import { describe, expect, it } from 'vitest';
import type { TreeNode } from '../model.ts';
import { activeSince, activityAt, moreRecent, orderSessions, orderTree, parseSessionOrder, recencyOf, recencyOfAll, treeRecency, type Timed } from './session-order.ts';

const node = (sessionId: string, children: TreeNode[] = []): TreeNode => ({ sessionId, via: null, movedFrom: null, children });
const s = (id: string, at: number | undefined, createdAt = 0, updatedAt = 0): Timed => ({ id, createdAt, updatedAt, ...(at === undefined ? {} : { lastActivityAt: at }) });
const lookupOf = (sessions: readonly Timed[]) => {
  const byId = new Map(sessions.map((x) => [x.id, x]));
  return (id: string) => byId.get(id);
};
const ids = (nodes: readonly TreeNode[]): unknown[] => nodes.map((n) => (n.children.length ? [n.sessionId, ids(n.children)] : n.sessionId));

describe('the session order setting', () => {
  it('is most recent unless custom is stored', () => {
    expect(parseSessionOrder('custom')).toBe('custom');
    expect(parseSessionOrder('recent')).toBe('recent');
    expect(parseSessionOrder(undefined)).toBe('recent');
    expect(parseSessionOrder('newest')).toBe('recent');
  });
});

describe('activity time', () => {
  it('is lastActivityAt, falling back to updatedAt for older records', () => {
    expect(activityAt({ updatedAt: 5, lastActivityAt: 9 })).toBe(9);
    expect(activityAt({ updatedAt: 5 })).toBe(5);
    expect(activityAt({ updatedAt: Number.NaN })).toBe(0);
  });
});

describe('most recent first', () => {
  it('puts the newest activity first', () => {
    const lookup = lookupOf([s('a', 10), s('b', 30), s('c', 20)]);
    expect(ids(orderTree([node('a'), node('b'), node('c')], lookup, 'recent', []))).toEqual(['b', 'c', 'a']);
  });

  it('places a parent by the newest activity in its whole subtree', () => {
    const lookup = lookupOf([s('p', 1), s('kid', 50), s('grand', 99), s('q', 60)]);
    const tree = [node('q'), node('p', [node('kid', [node('grand')])])];
    expect(ids(orderTree(tree, lookup, 'recent', []))).toEqual([['p', [['kid', ['grand']]]], 'q']);
  });

  it('orders children under one parent the same way', () => {
    const lookup = lookupOf([s('p', 100), s('x', 1), s('y', 3), s('z', 2)]);
    expect(ids(orderTree([node('p', [node('x'), node('y'), node('z')])], lookup, 'recent', []))).toEqual([['p', ['y', 'z', 'x']]]);
  });

  it('breaks ties by newer creation, then by id, whatever order they came in', () => {
    const lookup = lookupOf([s('b', 10, 1), s('a', 10, 1), s('c', 10, 2)]);
    const one = ids(orderTree([node('a'), node('b'), node('c')], lookup, 'recent', []));
    const other = ids(orderTree([node('c'), node('b'), node('a')], lookup, 'recent', []));
    expect(one).toEqual(['c', 'a', 'b']);
    expect(other).toEqual(one);
  });

  it('uses updatedAt where there is no activity time, and puts unknown sessions last', () => {
    const lookup = lookupOf([s('old', undefined, 0, 40), s('new', 30)]);
    expect(ids(orderTree([node('gone'), node('new'), node('old')], lookup, 'recent', []))).toEqual(['old', 'new', 'gone']);
  });

  it('returns the same nodes when nothing moves, so memoised rows keep their identity', () => {
    const lookup = lookupOf([s('a', 2), s('b', 1)]);
    const tree = [node('a', [node('b')])];
    const out = orderTree(tree, lookup, 'recent', []);
    expect(out).toBe(tree);
  });

  it('ignores the dragged order', () => {
    const lookup = lookupOf([s('a', 1), s('b', 2)]);
    expect(ids(orderTree([node('a'), node('b')], lookup, 'recent', ['a', 'b']))).toEqual(['b', 'a']);
  });

  it('sorts a flat list the same way', () => {
    const list = [s('a', 1, 5), s('b', 3), s('c', 1, 9)];
    expect(orderSessions(list, 'recent', ['a', 'b', 'c']).map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('custom order', () => {
  it('keeps the dragged order of top rows, new rows first, children as given', () => {
    const lookup = lookupOf([s('a', 1), s('b', 2), s('c', 3), s('k1', 9), s('k2', 1)]);
    const tree = [node('a', [node('k2'), node('k1')]), node('b'), node('c')];
    expect(ids(orderTree(tree, lookup, 'custom', ['b', 'a']))).toEqual(['c', 'b', ['a', ['k2', 'k1']]]);
  });

  it('keeps a flat list in the dragged order, or as given without one', () => {
    const list = [s('a', 1), s('b', 2), s('c', 3)];
    expect(orderSessions(list, 'custom', ['c', 'a']).map((x) => x.id)).toEqual(['b', 'c', 'a']);
    expect(orderSessions(list, 'custom', null).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
});

// Issue 83 (Matt, 2026-11-27): a session working now is the most recent, however lately another finished.
describe('how recent a session is: working now first', () => {
  const MIN = 60_000;
  const now = 100 * MIN;
  // Finished a minute ago; started five minutes ago and still going (its last activity was when it started).
  const finished: Timed = { id: 'finished', createdAt: now - 30 * MIN, updatedAt: now - MIN, lastActivityAt: now - MIN, state: 'done' };
  const going: Timed = { id: 'going', createdAt: now - 5 * MIN, updatedAt: now - 5 * MIN, lastActivityAt: now - 5 * MIN, state: 'running' };

  it('puts a session that is still going ahead of one that finished more lately', () => {
    expect(moreRecent(recencyOf(going), recencyOf(finished))).toBeLessThan(0);
    expect(orderSessions([finished, going], 'recent', null).map((x) => x.id)).toEqual(['going', 'finished']);
    expect(ids(orderTree([node('finished'), node('going')], lookupOf([finished, going]), 'recent', []))).toEqual(['going', 'finished']);
  });

  it('orders working sessions by their latest activity, and the rest as before', () => {
    const older: Timed = { ...going, id: 'older', lastActivityAt: now - 9 * MIN };
    const idle: Timed = { ...finished, id: 'idle', lastActivityAt: now - 20 * MIN };
    expect(orderSessions([idle, older, finished, going], 'recent', null).map((x) => x.id)).toEqual(['going', 'older', 'finished', 'idle']);
  });

  it('places a tree by its most recent session: a parent whose child is working rises above one that finished lately', () => {
    const parent: Timed = { id: 'parent', createdAt: 0, updatedAt: now - 40 * MIN, lastActivityAt: now - 40 * MIN, state: 'done' };
    const lookup = lookupOf([parent, going, finished]);
    expect(ids(orderTree([node('finished'), node('parent', [node('going')])], lookup, 'recent', []))).toEqual([['parent', ['going']], 'finished']);
    expect(treeRecency(node('parent', [node('going')]), lookup)).toEqual({ working: true, at: now - 5 * MIN });
  });

  it('keeps a hand-dragged order as it is', () => {
    expect(orderSessions([finished, going], 'custom', ['finished', 'going']).map((x) => x.id)).toEqual(['finished', 'going']);
  });

  it('counts a working session as active in any window', () => {
    expect(activeSince(going, now - MIN)).toBe(true);
    expect(activeSince(finished, now - 30_000)).toBe(false);
    expect(activeSince(finished, now - 2 * MIN)).toBe(true);
  });

  it('several together are working when any is, as late as the latest', () => {
    expect(recencyOfAll([recencyOf(finished), recencyOf(going)])).toEqual({ working: true, at: now - MIN });
    expect(recencyOfAll([])).toEqual({ working: false, at: -Infinity });
  });
});
