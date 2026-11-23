import { describe, expect, it } from 'vitest';
import type { TreeNode } from '../model.ts';
import type { PinRef } from './pins.ts';
import { emptyListKind, projectRowIds, projectSessionIds, sidebarHomes, type HomeSession } from './pinned-homes.ts';

const node = (sessionId: string, children: TreeNode[] = []): TreeNode => ({ sessionId, via: null, movedFrom: null, children });
const child = (sessionId: string, children: TreeNode[] = []): TreeNode => ({ sessionId, via: 'delegate', movedFrom: null, children });
const session = (id: string, projectId: string | null = null, status: HomeSession['filing']['status'] = 'landed'): HomeSession => ({ id, filing: { projectId, status } });
const ids = (nodes: readonly TreeNode[]): string[] => nodes.flatMap((n) => [n.sessionId, ...ids(n.children)]);

// Group g1 holds a (with delegate a1, which has a2) and b; group g2 holds c; d and e are ungrouped.
// a, a1, b and d are filed under project p1; c under p2; e has no project.
const trees = {
  g1: [node('a', [child('a1', [child('a2')])]), node('b')],
  g2: [node('c')],
  ungrouped: [node('d'), node('e')],
};
const sessions = [session('a', 'p1'), session('a1', 'p1'), session('a2', 'p1'), session('b', 'p1'), session('c', 'p2'), session('d', 'p1'), session('e')];
const homes = (pins: PinRef[]) => sidebarHomes({ pins, trees, sessions });
const pin = (kind: PinRef['kind'], id: string): PinRef => ({ kind, id });

describe('a pinned item leaves its home', () => {
  it('nothing pinned: every group as it was, the same objects; d is at home in its project list', () => {
    const h = homes([]);
    expect(h.pinned).toEqual([]);
    expect(h.trees.g1).toBe(trees.g1);
    expect(ids(h.trees.ungrouped!)).toEqual(['e']);
    expect([...h.inProjectList]).toEqual(['d']);
  });

  it('a pinned session leaves its group tree, the ungrouped list and its project list, and shows once under PINNED', () => {
    const h = homes([pin('session', 'b'), pin('session', 'e')]);
    expect(h.pinned.map((r) => r.id)).toEqual(['b', 'e']);
    expect(ids(h.trees.g1!)).toEqual(['a', 'a1', 'a2']);
    expect(ids(h.trees.ungrouped!)).toEqual([]);
    expect(projectSessionIds(sessions, 'p1', h.pinnedAway)).toEqual(['a', 'a1', 'a2', 'd']);
    expect(projectRowIds(sessions, 'p1', h.inProjectList, h.pinnedAway)).toEqual(['d']);
  });

  it('a pinned session takes what hangs under it along, drawn under its PINNED row', () => {
    const h = homes([pin('session', 'a')]);
    const row = h.pinned[0]!;
    expect(row.kind === 'session' && ids([row.node])).toEqual(['a', 'a1', 'a2']);
    expect(ids(h.trees.g1!)).toEqual(['b']);
    expect(projectSessionIds(sessions, 'p1', h.pinnedAway)).toEqual(['b', 'd']);
  });

  it('a pinned delegate is cut out of its parent tree; the parent stays', () => {
    const h = homes([pin('session', 'a1')]);
    expect(ids(h.trees.g1!)).toEqual(['a', 'b']);
    expect(h.trees.g1![1]).toBe(trees.g1[1]); // untouched rows keep their identity
  });

  it('pinned groups and projects are named so their lists can leave them out', () => {
    const h = homes([pin('group', 'g2'), pin('project', 'p2')]);
    expect([...h.pinnedGroups]).toEqual(['g2']);
    expect([...h.pinnedProjects]).toEqual(['p2']);
    expect(h.pinned).toEqual([{ kind: 'group', id: 'g2' }, { kind: 'project', id: 'p2' }]);
    expect(h.trees.g2).toBe(trees.g2); // a pinned group still has its whole tree to draw
  });

  it('keeps the order of the pins, across kinds', () => {
    expect(homes([pin('project', 'p2'), pin('session', 'd'), pin('group', 'g1')]).pinned.map((r) => `${r.kind}:${r.id}`)).toEqual(['project:p2', 'session:d', 'group:g1']);
  });
});

describe('a pinned session inside another pinned item shows once, inside it', () => {
  it('inside a pinned group: no row of its own, still in the group tree', () => {
    const h = homes([pin('group', 'g1'), pin('session', 'b')]);
    expect(h.pinned).toEqual([{ kind: 'group', id: 'g1' }]);
    expect(ids(trees.g1)).toContain('b');
  });

  it('inside a pinned project: no row of its own; the pinned project lists it', () => {
    const h = homes([pin('session', 'd'), pin('project', 'p1')]);
    expect(h.pinned).toEqual([{ kind: 'project', id: 'p1' }]);
    expect(projectSessionIds(sessions, 'p1')).toContain('d');
  });

  it('under a pinned session drawn on its own: a pinned project leaves it out of its list', () => {
    // e is ungrouped with no project; give it a delegate filed under p2, and pin e and p2.
    const withChild = { ...trees, ungrouped: [node('d'), node('e', [child('e1')])] };
    const h = sidebarHomes({ pins: [pin('session', 'e'), pin('project', 'p2')], trees: withChild, sessions: [...sessions, session('e1', 'p2')] });
    expect(h.pinned.map((r) => r.id)).toEqual(['e', 'p2']);
    expect(projectSessionIds([...sessions, session('e1', 'p2')], 'p2', h.inSessionRows)).toEqual(['c']);
  });

  it('under a pinned session: drawn under it, no row of its own', () => {
    const h = homes([pin('session', 'a2'), pin('session', 'a')]);
    expect(h.pinned.map((r) => r.id)).toEqual(['a']);
  });

  it('gets its own row back when the item around it is unpinned', () => {
    expect(homes([pin('session', 'b')]).pinned.map((r) => r.id)).toEqual(['b']);
  });
});

describe('edges', () => {
  it('a group whose every session is pinned stays in the list, empty', () => {
    const h = homes([pin('session', 'c')]);
    expect(h.trees.g2).toEqual([]);
    expect(h.pinnedGroups.has('g2')).toBe(false);
  });

  it('a pin whose session is not in any tree draws nothing', () => {
    expect(homes([pin('session', 'gone')]).pinned).toEqual([]);
  });

  it('a hidden session is in no project list, pinned or not', () => {
    expect(projectSessionIds([session('h', 'p1', 'hidden'), session('k', 'p1')], 'p1')).toEqual(['k']);
  });
});

describe('what an empty list draws', () => {
  it('a project or group with rows draws nothing; with none, a note when its sessions are pinned away, else a row to create one', () => {
    const h = homes([pin('session', 'c')]);
    expect(emptyListKind(projectSessionIds(sessions, 'p2').length, projectSessionIds(sessions, 'p2', h.pinnedAway).length)).toBe('all-pinned');
    expect(emptyListKind(ids(trees.g2).length, ids(h.trees.g2!).length)).toBe('all-pinned');
    expect(emptyListKind(projectSessionIds(sessions, 'p3').length, 0)).toBe('create');
    expect(emptyListKind(4, projectSessionIds(sessions, 'p1', h.pinnedAway).length)).toBeNull();
  });
});

describe('a review session leaves its home for CODE REVIEWS', () => {
  const reviewing = (pins: PinRef[], ...sessionIds: string[]) => sidebarHomes({ pins, trees, sessions, reviewing: new Set(sessionIds) });

  it('none reviewing: nothing changes, and the same objects come back', () => {
    const h = reviewing([]);
    expect(h.reviews).toEqual([]);
    expect(h.away).toBe(h.pinnedAway);
    expect(h.trees.g1).toBe(trees.g1);
  });

  it('leaves its group tree and its project list, and shows once, with what hangs under it', () => {
    const h = reviewing([], 'a', 'd');
    expect(h.reviews.map((r) => r.id)).toEqual(['a', 'd']);
    expect(ids([h.reviews[0]!.node])).toEqual(['a', 'a1', 'a2']);
    expect(ids(h.trees.g1!)).toEqual(['b']);
    expect([...h.reviewAway].sort()).toEqual(['a', 'a1', 'a2', 'd']);
    expect(projectRowIds(sessions, 'p1', h.inProjectList, h.away)).toEqual([]);
    expect(h.pinnedAway.size).toBe(0);
  });

  it('a review session under another review session’s row has no row of its own', () => {
    const h = reviewing([], 'a', 'a1');
    expect(h.reviews.map((r) => r.id)).toEqual(['a']);
    const childFirst = sidebarHomes({ pins: [], trees, sessions: [...sessions].reverse(), reviewing: new Set(['a', 'a1']) });
    expect(childFirst.reviews.map((r) => r.id)).toEqual(['a']);
  });

  it('stays under PINNED when it is pinned, or inside a pinned group', () => {
    expect(reviewing([pin('session', 'b')], 'b').reviews).toEqual([]);
    const inGroup = reviewing([pin('group', 'g2')], 'c');
    expect(inGroup.reviews).toEqual([]);
    expect(ids(inGroup.trees.g2!)).toEqual(['c']);
  });

  it('what is pinned from under a review session is drawn under PINNED, not twice', () => {
    const h = reviewing([pin('session', 'a1')], 'a');
    expect(h.pinned.map((r) => r.id)).toEqual(['a1']);
    expect(ids([h.reviews[0]!.node])).toEqual(['a']);
  });
});

describe('a ticket’s lead leaves its home for TICKETS', () => {
  const leads = (pins: PinRef[], entries: [string, string][], reviewingIds: string[] = []) => sidebarHomes({ pins, trees, sessions, reviewing: new Set(reviewingIds), ticketLeads: new Map(entries) });

  it('none: nothing changes, and the same objects come back', () => {
    const h = leads([], []);
    expect(h.tickets).toEqual([]);
    expect(h.away).toBe(h.pinnedAway);
  });

  it('leaves its group tree and its project list, and shows once with its ticket and what hangs under it', () => {
    const h = leads([], [['a', 'fake:BELL-1']]);
    expect(h.tickets.map((t) => [t.id, t.key])).toEqual([['a', 'fake:BELL-1']]);
    expect(ids([h.tickets[0]!.node])).toEqual(['a', 'a1', 'a2']);
    expect(ids(h.trees.g1!)).not.toContain('a');
    expect(projectRowIds(sessions, 'p1', h.inProjectList, h.away)).not.toContain('a');
  });

  it('stays under PINNED or CODE REVIEWS when either draws it already', () => {
    expect(leads([pin('session', 'a')], [['a', 'fake:BELL-1']]).tickets).toEqual([]);
    expect(leads([], [['a', 'fake:BELL-1']], ['a']).tickets).toEqual([]);
  });
});
