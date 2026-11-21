import { describe, expect, it } from 'vitest';
import type { LinkKind, SessionView, TreeNode } from '../model.ts';
import type { PinRef } from './pins.ts';
import { projectRowIds, sidebarHomes, type HomeSession, type SidebarHomes } from './pinned-homes.ts';
import { tagSessionIds } from './status.ts';

const root = (sessionId: string, children: TreeNode[] = []): TreeNode => ({ sessionId, via: null, movedFrom: null, children });
const under = (via: LinkKind) => (sessionId: string, children: TreeNode[] = []): TreeNode => ({ sessionId, via, movedFrom: null, children });
const delegated = under('delegate');
/** A session a task was handed off to: a row of its own, beside the one that handed it off, marked with where it came from (tree.ts). */
const handedOff = (sessionId: string, from: string, children: TreeNode[] = []): TreeNode => ({ sessionId, via: null, movedFrom: from, children });
const session = (id: string, projectId: string | null = null, status: HomeSession['filing']['status'] = projectId ? 'pending' : 'unscoped'): HomeSession => ({ id, filing: { projectId, status } });
const ids = (nodes: readonly TreeNode[]): string[] => nodes.flatMap((n) => [n.sessionId, ...ids(n.children)]);

/** A project's rows, each followed by what is drawn under it. */
const withNested = (rowIds: readonly string[], homes: SidebarHomes): string[] => rowIds.flatMap((id) => [id, ...ids(homes.nestedInProject.get(id) ?? [])]);

interface World {
  trees: Record<string, TreeNode[]>;
  sessions: HomeSession[];
  pins?: PinRef[];
}

/**
 * Every row the sidebar draws, as Sidebar.tsx draws it: PINNED (a session with its tree, a group
 * with its whole tree, a project with its list minus what pinned session rows draw), then the
 * unpinned groups and the ungrouped Sessions list, then the unpinned projects' lists.
 */
function drawn({ trees, sessions, pins = [] }: World): { rows: string[]; homes: SidebarHomes } {
  const homes = sidebarHomes({ pins, trees, sessions });
  const projects = [...new Set(sessions.map((s) => s.filing.projectId).filter((p): p is string => !!p))];
  const rows: string[] = [];
  for (const row of homes.pinned) {
    if (row.kind === 'session') rows.push(...ids([row.node]));
    if (row.kind === 'group') rows.push(...ids(trees[row.id] ?? []));
    if (row.kind === 'project') rows.push(...withNested(projectRowIds(sessions, row.id, homes.inProjectList, homes.inSessionRows), homes));
  }
  for (const [key, tree] of Object.entries(homes.trees)) if (!homes.pinnedGroups.has(key)) rows.push(...ids(tree));
  for (const p of projects) if (!homes.pinnedProjects.has(p)) rows.push(...withNested(projectRowIds(sessions, p, homes.inProjectList, homes.pinnedAway), homes));
  return { rows, homes };
}

/** Each session is drawn exactly once: nothing twice, nothing lost. */
function expectOnce(world: World): SidebarHomes {
  const { rows, homes } = drawn(world);
  expect([...rows].sort()).toEqual(world.sessions.map((s) => s.id).sort());
  return homes;
}

describe('every session has exactly one home', () => {
  it('a delegated child stays nested under its parent in the Sessions list, not in its project list', () => {
    const world = { trees: { ungrouped: [root('o', [delegated('w', [])])] }, sessions: [session('o'), session('w', 'p1')] };
    const h = expectOnce(world);
    expect(h.trees.ungrouped).toBe(world.trees.ungrouped);
    expect(h.inProjectList.has('w')).toBe(false);
  });

  it('a session a task was handed off to, with a project, goes to its project list', () => {
    const world = { trees: { ungrouped: [root('o'), handedOff('h', 'o')] }, sessions: [session('o', null, 'hidden'), session('h', 'p1')] };
    const h = expectOnce(world);
    expect(ids(h.trees.ungrouped!)).toEqual(['o']);
    expect(projectRowIds(world.sessions, 'p1', h.inProjectList)).toEqual(['h']);
  });

  it('one without a project stays in the Sessions list, beside the session that handed off: it has no list of its own', () => {
    const world = { trees: { ungrouped: [root('o'), handedOff('h', 'o')] }, sessions: [session('o'), session('h', null, 'hidden')] };
    const h = expectOnce(world);
    expect(ids(h.trees.ungrouped!)).toEqual(['o', 'h']);
  });

  it('a pinned one is drawn once, flat, under PINNED', () => {
    const world = { trees: { ungrouped: [root('o'), handedOff('h', 'o')] }, sessions: [session('o'), session('h', 'p1')], pins: [{ kind: 'session', id: 'h' } as PinRef] };
    const h = expectOnce(world);
    expect(h.pinned).toEqual([{ kind: 'session', id: 'h', node: root('h') }]);
  });

  it('a pinned delegated child is cut out of its parent and drawn under PINNED', () => {
    const world = { trees: { ungrouped: [root('o', [delegated('w')])] }, sessions: [session('o'), session('w', 'p1')], pins: [{ kind: 'session', id: 'w' } as PinRef] };
    const h = expectOnce(world);
    expect(ids(h.trees.ungrouped!)).toEqual(['o']);
  });

  it('in a group, a delegate nests under its parent, a handed-off session sits beside it, and no project list shows them', () => {
    const world = {
      trees: { g1: [root('o', [delegated('w')]), handedOff('h', 'o')], ungrouped: [] },
      sessions: [session('o', 'p1', 'landed'), session('h', 'p2'), session('w', 'p3')],
    };
    const h = expectOnce(world);
    expect(h.trees.g1).toBe(world.trees.g1);
    expect(h.inProjectList.size).toBe(0);
  });

  it('grandchildren find their own home when the row above them goes to a project list', () => {
    // o (no project) hands off to h (p1); h delegates to x (no project) and y (p2).
    // o also delegates to d (no project), which hands off to z (p3).
    const world = {
      trees: { ungrouped: [root('o', [delegated('d')]), handedOff('h', 'o', [delegated('x'), delegated('y')]), handedOff('z', 'd')] },
      sessions: [session('o', null, 'hidden'), session('h', 'p1'), session('x'), session('y', 'p2'), session('d'), session('z', 'p3')],
    };
    const h = expectOnce(world);
    expect(ids(h.trees.ungrouped!)).toEqual(['o', 'd', 'x']);
    // x stands at the top of the Sessions list with a "from" mark for h.
    expect(h.trees.ungrouped![1]).toEqual({ sessionId: 'x', via: null, movedFrom: 'h', children: [] });
    expect([...h.inProjectList].sort()).toEqual(['h', 'y', 'z']);
  });

  it('a session with a project at the top of the Sessions list goes to its project list; its unscoped child is lifted', () => {
    const world = { trees: { ungrouped: [root('a', [delegated('b')])] }, sessions: [session('a', 'p1', 'landed'), session('b')] };
    const h = expectOnce(world);
    expect(h.trees.ungrouped).toEqual([{ sessionId: 'b', via: null, movedFrom: 'a', children: [] }]);
  });

  it('a tagged child is drawn once in its home; its tag lists it as well (tags are additional)', () => {
    const world = { trees: { ungrouped: [root('o'), handedOff('h', 'o')] }, sessions: [session('o'), session('h', 'p1')] };
    expectOnce(world);
    const views = world.sessions.map((s) => ({ ...s, title: s.id, tags: s.id === 'h' ? ['ui'] : [], updatedAt: 0, createdAt: 0 }) as unknown as SessionView);
    expect(tagSessionIds(views, 'ui')).toEqual(['h']);
  });

  it('a pinned project lists its handed-off child once', () => {
    const world = { trees: { ungrouped: [root('o'), handedOff('h', 'o')] }, sessions: [session('o'), session('h', 'p1')], pins: [{ kind: 'project', id: 'p1' } as PinRef] };
    expectOnce(world);
  });
});

describe('a delegate inside one project', () => {
  it('is drawn under its parent in the project’s list, and so are its own same-project delegates', () => {
    const world: World = { trees: { ungrouped: [root('p', [delegated('c1', [delegated('g1')]), delegated('c2')])] }, sessions: [session('p', 'shop'), session('c1', 'shop'), session('g1', 'shop'), session('c2', 'shop')] };
    const { homes, rows } = drawn(world);
    expect(projectRowIds(world.sessions, 'shop', homes.inProjectList)).toEqual(['p']);
    expect(homes.nestedInProject.get('p')).toEqual([delegated('c1', [delegated('g1')]), delegated('c2')]);
    expect(rows.sort()).toEqual(['c1', 'c2', 'g1', 'p']);
    expect(homes.trees.ungrouped).toEqual([]);
  });

  it('keeps a delegate in another project, or one with no project, out from under it', () => {
    const world: World = { trees: { ungrouped: [root('p', [delegated('same'), delegated('other'), delegated('none')])] }, sessions: [session('p', 'shop'), session('same', 'shop'), session('other', 'docs'), session('none')] };
    const { homes, rows } = drawn(world);
    expect(ids(homes.nestedInProject.get('p') ?? [])).toEqual(['same']);
    expect(projectRowIds(world.sessions, 'docs', homes.inProjectList)).toEqual(['other']);
    expect(homes.trees.ungrouped!.map((n) => [n.sessionId, n.movedFrom])).toEqual([['none', 'p']]);
    expect(rows.sort()).toEqual(['none', 'other', 'p', 'same']);
  });

  it('goes to PINNED with a pinned parent, and leaves its parent when pinned itself', () => {
    const world: World = { trees: { ungrouped: [root('p', [delegated('c1'), delegated('c2')])] }, sessions: [session('p', 'shop'), session('c1', 'shop'), session('c2', 'shop')] };
    const parentPinned = drawn({ ...world, pins: [{ kind: 'session', id: 'p' }] });
    expect(parentPinned.homes.pinned).toEqual([{ kind: 'session', id: 'p', node: root('p', [delegated('c1'), delegated('c2')]) }]);
    expect(parentPinned.rows.sort()).toEqual(['c1', 'c2', 'p']);
    const childPinned = drawn({ ...world, pins: [{ kind: 'session', id: 'c1' }] });
    expect(childPinned.homes.pinned.map((r) => r.id)).toEqual(['c1']);
    expect(ids(childPinned.homes.nestedInProject.get('p') ?? [])).toEqual(['c2']);
    expect(childPinned.rows.sort()).toEqual(['c1', 'c2', 'p']);
  });
});
