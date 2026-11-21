import { describe, expect, it } from 'vitest';
import { fitsGroup, joinRefusal, moveGroupRefusal, projectOfSession } from './project-groups.ts';

const names: Record<string, string> = { p1: 'Kestrel', p2: 'Wren' };
const name = (id: string) => names[id] ?? '';
const s = (title: string, startedIn: string | null, landedIn: string | null = null) => ({ title, startedIn, landedIn });

describe('project groups', () => {
  it('counts a session as belonging where its work landed, else where it started', () => {
    expect(projectOfSession(s('a', 'p1'))).toBe('p1');
    expect(projectOfSession(s('a', 'p1', 'p2'))).toBe('p2');
    expect(projectOfSession(s('a', null))).toBeNull();
  });

  it('lets any session into a Sessions-list group, and only the project’s own into a project’s group', () => {
    expect(fitsGroup({ projectId: null }, s('a', 'p2'))).toBe(true);
    expect(fitsGroup({}, s('a', null))).toBe(true);
    expect(fitsGroup({ projectId: 'p1' }, s('a', 'p1'))).toBe(true);
    expect(fitsGroup({ projectId: 'p1' }, s('a', 'p2'))).toBe(false);
    expect(fitsGroup({ projectId: 'p1' }, s('a', null))).toBe(false);
  });

  it('says why a session from another project cannot join, and what to do instead', () => {
    expect(joinRefusal({ name: 'Launch', projectId: 'p1' }, s('Fix nav', 'p1'), name)).toBeNull();
    expect(joinRefusal({ name: 'Launch', projectId: 'p1' }, s('Fix nav', 'p2'), name)).toMatch(/“Fix nav” belongs to Wren, and “Launch” is a group in Kestrel\. Move the session to that project first/);
  });

  it('moves a Sessions-list group into a project only when everything in it belongs there', () => {
    expect(moveGroupRefusal({ name: 'Launch', projectId: null }, 'p1', [s('a', 'p1'), s('b', 'p2', 'p1')], name)).toBeNull();
    expect(moveGroupRefusal({ name: 'Launch', projectId: null }, 'p1', [s('a', 'p1'), s('b', 'p2')], name)).toMatch(/holds “b”, which belongs to another project/);
  });

  it('never moves a project’s group to another project', () => {
    expect(moveGroupRefusal({ name: 'Launch', projectId: 'p1' }, 'p1', [], name)).toBeNull();
    expect(moveGroupRefusal({ name: 'Launch', projectId: 'p1' }, 'p2', [], name)).toMatch(/stays in its project/);
  });
});
