import { describe, expect, test } from 'vitest';
import { fileSession, nextLandedIn, sessionsInProject } from './filing.ts';
import type { Link } from './model.ts';

const s = (id: string, startedIn: string | null, landedIn: string | null, worktreeDiscarded = false) => ({ id, startedIn, landedIn, worktreeDiscarded });
const link = (parentId: string, childId: string, kind: Link['kind']): Link => ({ id: `${parentId}>${childId}`, parentId, childId, kind });

describe('nextLandedIn', () => {
  test('stays unset while the worktree matches its base', () => {
    expect(nextLandedIn(null, { projectId: 'platform', differsFromBase: false })).toBeNull();
  });
  test('is set to the worktree project once it differs from base', () => {
    expect(nextLandedIn(null, { projectId: 'platform', differsFromBase: true })).toBe('platform');
  });
  test('keeps the stored value when the worktree is gone', () => {
    expect(nextLandedIn('platform', null)).toBe('platform');
  });
  test('keeps the stored value when the changes are later undone', () => {
    expect(nextLandedIn('platform', { projectId: 'platform', differsFromBase: false })).toBe('platform');
  });
});

describe('fileSession: ordinary sessions', () => {
  test('files under landedIn when work exists, even if it started elsewhere', () => {
    expect(fileSession(s('a', 'bellbird', 'platform'), [])).toEqual({ projectId: 'platform', status: 'landed', discarded: false });
  });
  test('falls back to startedIn when nothing has changed', () => {
    expect(fileSession(s('a', 'bellbird', null), [])).toEqual({ projectId: 'bellbird', status: 'started', discarded: false });
  });
  test('is Unscoped with no project and no change', () => {
    expect(fileSession(s('a', null, null), [])).toEqual({ projectId: null, status: 'unscoped', discarded: false });
  });
  test('marks a landed session whose worktree was discarded', () => {
    expect(fileSession(s('a', 'bellbird', 'bellbird', true), [])).toEqual({ projectId: 'bellbird', status: 'landed', discarded: true });
  });
});

describe('fileSession: children', () => {
  test('a handoff child with no change yet is pending under the project it was started in', () => {
    const links = [link('p', 'c', 'handoff')];
    expect(fileSession(s('c', 'platform', null), links)).toEqual({ projectId: 'platform', status: 'pending', discarded: false });
  });
  test('a delegate child with no change yet is pending too', () => {
    const links = [link('o', 'c', 'delegate')];
    expect(fileSession(s('c', 'docs', null), links).status).toBe('pending');
  });
  test('git evidence wins over where the handoff started the child', () => {
    const links = [link('p', 'c', 'handoff')];
    expect(fileSession(s('c', 'platform', 'docs'), links)).toEqual({ projectId: 'docs', status: 'landed', discarded: false });
  });
});

describe('fileSession: parents', () => {
  test('a parent that handed off and changed nothing stays in the project it was started in', () => {
    const links = [link('p', 'c', 'handoff')];
    expect(fileSession(s('p', 'bellbird', null), links)).toEqual({ projectId: 'bellbird', status: 'started', discarded: false });
  });
  test('a parent with no project that handed off and changed nothing is not listed in any project', () => {
    const links = [link('p', 'c', 'handoff')];
    expect(fileSession(s('p', null, null), links)).toEqual({ projectId: null, status: 'hidden', discarded: false });
  });
  test('a parent that handed off after making changes stays under its own landedIn', () => {
    const links = [link('p', 'c', 'handoff')];
    expect(fileSession(s('p', 'bellbird', 'bellbird'), links)).toEqual({ projectId: 'bellbird', status: 'landed', discarded: false });
  });
  test('a delegate orchestrator follows the ordinary rule', () => {
    const links = [link('o', 'c1', 'delegate'), link('o', 'c2', 'delegate')];
    expect(fileSession(s('o', null, null), links).status).toBe('unscoped');
    expect(fileSession(s('o', 'bellbird', null), links)).toEqual({ projectId: 'bellbird', status: 'started', discarded: false });
  });
  test('parent rules win for a session that is both a child and a handing-off parent', () => {
    // mid is a child of top and handed off to leaf without changing anything.
    const links = [link('top', 'mid', 'handoff'), link('mid', 'leaf', 'handoff')];
    // It is a child, which would make it "pending"; as a parent that handed off it is simply where it started.
    expect(fileSession(s('mid', 'platform', null), links)).toEqual({ projectId: 'platform', status: 'started', discarded: false });
  });
});

describe('sessionsInProject', () => {
  test('lists sessions whose work landed there, not sessions that started there; a parent that handed off stays where it started', () => {
    const sessions = [s('started-here-landed-elsewhere', 'bellbird', 'platform'), s('landed-here', 'docs', 'bellbird'), s('parent', 'bellbird', null), s('child', 'platform', null)];
    const links = [link('parent', 'child', 'handoff')];
    expect(sessionsInProject('bellbird', sessions, links).map((x) => x.id)).toEqual(['landed-here', 'parent']);
    expect(sessionsInProject('platform', sessions, links).map((x) => x.id)).toEqual(['started-here-landed-elsewhere', 'child']);
  });
});
