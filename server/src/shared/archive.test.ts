import { describe, expect, it } from 'vitest';
import { NOTHING_ARCHIVED, isArchiveKind, pruneArchived, sanitizeArchived, sessionHidden, setArchived } from './archive.ts';

describe('archiving', () => {
  it('archives and restores one thing, and changes nothing when already so', () => {
    const one = setArchived(NOTHING_ARCHIVED, 'session', 's1', true);
    expect(one.sessions).toEqual(['s1']);
    expect(setArchived(one, 'session', 's1', true)).toBe(one);
    expect(setArchived(one, 'session', 's1', false).sessions).toEqual([]);
    expect(setArchived(one, 'project', 'p1', true)).toEqual({ sessions: ['s1'], projects: ['p1'], groups: [] });
  });
  it('hides a session that is archived, in an archived group, or in an archived project', () => {
    const archived = { sessions: ['a'], projects: ['p'], groups: ['g'] };
    expect(sessionHidden({ id: 'a', groupId: null, projectId: null }, archived)).toBe(true);
    expect(sessionHidden({ id: 'b', groupId: 'g', projectId: null }, archived)).toBe(true);
    expect(sessionHidden({ id: 'c', groupId: null, projectId: 'p' }, archived)).toBe(true);
    expect(sessionHidden({ id: 'd', groupId: 'other', projectId: 'q' }, archived)).toBe(false);
  });
  it('forgets ids that no longer exist', () => {
    const archived = { sessions: ['a', 'gone'], projects: ['p'], groups: [] };
    expect(pruneArchived(archived, { sessions: new Set(['a']), projects: new Set(['p']), groups: new Set() })).toEqual({ sessions: ['a'], projects: ['p'], groups: [] });
    const same = { sessions: ['a'], projects: [], groups: [] };
    expect(pruneArchived(same, { sessions: new Set(['a']), projects: new Set(), groups: new Set() })).toBe(same);
  });
  it('keeps only well-formed stored data', () => {
    expect(sanitizeArchived({ sessions: ['a', 1, 'a'], projects: 'x' })).toEqual({ sessions: ['a'], projects: [], groups: [] });
    expect(sanitizeArchived(null)).toEqual(NOTHING_ARCHIVED);
    expect(isArchiveKind('group')).toBe(true);
    expect(isArchiveKind('tab')).toBe(false);
  });
});
