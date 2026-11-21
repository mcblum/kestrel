import { describe, expect, it } from 'vitest';
import type { TreeNode } from '../model.ts';
import { activeHome } from './active-home.ts';
import { sidebarHomes } from './pinned-homes.ts';

const node = (sessionId: string, children: TreeNode[] = []): TreeNode => ({ sessionId, via: null, movedFrom: null, children });
const filed = (id: string, projectId: string | null) => ({ id, filing: { projectId, status: 'landed' as const } });

// Sessions list: loose `a` (with child `a2`), group `g` holding `b`. Project `p`: loose `c`, its group `pg` holding `d`.
const trees = { ungrouped: [node('a', [node('a2')]), node('c')], g: [node('b')], pg: [node('d')] };
const sessions = [filed('a', null), filed('a2', null), filed('b', null), filed('c', 'p'), filed('d', 'p')];
const groups = [{ id: 'g', projectId: null }, { id: 'pg', projectId: 'p' }];
const where = (id: string | null, pins: { kind: 'session' | 'group' | 'project'; id: string }[] = []) =>
  activeHome(sidebarHomes({ pins, trees, sessions }), groups, sessions, id);

describe('where the open session is drawn, for collapsed containers', () => {
  it('a loose session in the Sessions list, or one nested under it', () => {
    expect(where('a')).toEqual({ section: 'sessions', groupId: null });
    expect(where('a2')).toEqual({ section: 'sessions', groupId: null });
  });
  it('a session in a Sessions-list group', () => {
    expect(where('b')).toEqual({ section: 'sessions', groupId: 'g' });
  });
  it("a session in its project's list, or in one of the project's groups", () => {
    expect(where('c')).toEqual({ section: 'projects', projectId: 'p', groupId: null });
    expect(where('d')).toEqual({ section: 'projects', projectId: 'p', groupId: 'pg' });
  });
  it('a pinned session, or one inside a pinned group or project, is drawn under PINNED', () => {
    expect(where('a', [{ kind: 'session', id: 'a' }])).toEqual({ section: 'pinned' });
    expect(where('b', [{ kind: 'group', id: 'g' }])).toEqual({ section: 'pinned' });
    expect(where('d', [{ kind: 'project', id: 'p' }])).toEqual({ section: 'pinned' });
  });
  it('nothing when no session is open or it is not drawn', () => {
    expect(where(null)).toBeNull();
    expect(where('gone')).toBeNull();
  });
});

describe('a delegate drawn under its parent in a project’s list', () => {
  it('counts as being in that project, so a folded project still shows it', () => {
    const child: TreeNode = { sessionId: 'kid', via: 'delegate', movedFrom: null, children: [] };
    const homes = sidebarHomes({ pins: [], trees: { ungrouped: [node('parent', [child])] }, sessions: [filed('parent', 'p'), filed('kid', 'p')] });
    expect(activeHome(homes, [], [filed('parent', 'p'), filed('kid', 'p')], 'kid')).toEqual({ section: 'projects', projectId: 'p', groupId: null });
  });
});
