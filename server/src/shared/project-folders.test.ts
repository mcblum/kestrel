import { describe, expect, it } from 'vitest';
import type { Project } from '../model.ts';
import { defaultFolder, folderName, folderSummary, folderOf, folderParent, hasFolders, isFolderPermutation, lastUsedFolder, normalizeProject, otherFolders, placeFolder, projectPath, settledDefaultId, withSettledDefault, repositoryLabel, resolveStartedFolder } from './project-folders.ts';

const web = { id: 'w', path: '/c/web', isGit: true };
const api = { id: 'a', path: '/c/api', isGit: true };
const notes = { id: 'n', path: '/c/notes', isGit: false };
const several: Project = { id: 'p', name: 'Shop', folders: [web, api, notes] };
const one: Project = { id: 'q', name: 'Solo', folders: [web] };
const none: Project = { id: 'r', name: 'Ideas', folders: [] };

describe('a project’s directories', () => {
  it('has the first as its default when none is chosen, and none when it has none', () => {
    expect(defaultFolder(several)).toBe(web);
    expect(defaultFolder(none)).toBeNull();
    expect(hasFolders(none)).toBe(false);
    expect(projectPath(several)).toBe('/c/web');
    expect(projectPath(none)).toBeNull();
  });

  it('uses the chosen default wherever it is in the order, and the first once the chosen one is gone', () => {
    const chosen: Project = { ...several, defaultFolderId: 'n' };
    expect(defaultFolder(chosen)).toBe(notes);
    expect(projectPath(chosen)).toBe('/c/notes');
    expect(otherFolders(chosen)).toEqual([web, api]);
    expect(lastUsedFolder(chosen, [])).toBe(notes);
    const removed: Project = { ...chosen, folders: [api, web] };
    expect(defaultFolder(removed)).toBe(api);
    expect(settledDefaultId(removed)).toBe('a');
    expect(withSettledDefault(removed).defaultFolderId).toBe('a');
    expect(withSettledDefault(none).defaultFolderId).toBeNull();
    expect(withSettledDefault(chosen).defaultFolderId).toBe('n');
  });

  it('sums a project up in one line: the default folder and how many there are, or none yet', () => {
    expect(folderSummary(none)).toEqual({ path: null, count: 'No folder yet' });
    expect(folderSummary(one)).toEqual({ path: '/c/web', count: '1 folder' });
    expect(folderSummary({ ...several, defaultFolderId: 'n' })).toEqual({ path: '/c/notes', count: '3 folders' });
  });

  it('finds one by id, and nothing for a missing or empty id', () => {
    expect(folderOf(several, 'a')).toBe(api);
    expect(folderOf(several, 'x')).toBeNull();
    expect(folderOf(several, null)).toBeNull();
  });

  it('names a directory by its last part, with the path above it', () => {
    expect(folderName({ path: '/Users/me/Code/web/' })).toBe('web');
    expect(folderParent({ path: '/Users/me/Code/web' })).toBe('/Users/me/Code');
    expect(folderParent({ path: '/web' })).toBe('');
  });

  it('names a repository by the project, adding the directory only when there are several', () => {
    expect(repositoryLabel(several, api)).toBe('Shop · api');
    expect(repositoryLabel(one, web)).toBe('Solo');
    expect(repositoryLabel(several, null)).toBe('Shop');
  });
});

describe('the directory a session started in', () => {
  const repoOf = (worktree: string) => (worktree === '/data/worktrees/s1' ? '/c/api' : null);

  it('is the one it recorded while the project still has it', () => {
    expect(resolveStartedFolder(several, { startedFolderId: 'n', worktreePath: null })).toBe(notes);
  });

  it('for a session from before, is the directory its worktree was cut from', () => {
    expect(resolveStartedFolder(several, { startedFolderId: null, worktreePath: '/data/worktrees/s1' }, repoOf)).toBe(api);
  });

  it('otherwise is the default: no worktree, an unknown repository, or a directory removed since', () => {
    expect(resolveStartedFolder(several, { startedFolderId: null, worktreePath: null }, repoOf)).toBe(web);
    expect(resolveStartedFolder(several, { startedFolderId: null, worktreePath: '/data/worktrees/other' }, repoOf)).toBe(web);
    expect(resolveStartedFolder(several, { startedFolderId: 'gone', worktreePath: null }, repoOf)).toBe(web);
  });

  it('is none in a project with no directory, or with no project', () => {
    expect(resolveStartedFolder(none, { startedFolderId: null, worktreePath: null })).toBeNull();
    expect(resolveStartedFolder(null, { startedFolderId: 'w', worktreePath: null })).toBeNull();
  });

  it('does not read the worktree when one directory makes the answer certain', () => {
    let asked = 0;
    resolveStartedFolder(one, { startedFolderId: null, worktreePath: '/data/worktrees/s1' }, () => (asked++, null));
    expect(asked).toBe(0);
  });
});

describe('choosing and ordering directories', () => {
  it('starts a new session where the newest session in the project worked', () => {
    const sessions = [
      { startedIn: 'p', createdAt: 1, folderId: 'a' },
      { startedIn: 'p', createdAt: 3, folderId: 'n' },
      { startedIn: 'other', createdAt: 9, folderId: 'w' },
    ];
    expect(lastUsedFolder(several, sessions)).toBe(notes);
    expect(lastUsedFolder(several, [])).toBe(web);
    expect(lastUsedFolder(several, [{ startedIn: 'p', createdAt: 5, folderId: 'removed' }])).toBe(web);
  });

  it('moves one directory before or after another', () => {
    expect(placeFolder(['w', 'a', 'n'], 'n', 'w', false)).toEqual(['n', 'w', 'a']);
    expect(placeFolder(['w', 'a', 'n'], 'w', 'a', true)).toEqual(['a', 'w', 'n']);
    expect(placeFolder(['w', 'a'], 'w', 'w', true)).toEqual(['w', 'a']);
    expect(placeFolder(['w', 'a'], 'x', 'w', true)).toEqual(['w', 'a']);
  });

  it('accepts a new order only when it lists each directory once', () => {
    expect(isFolderPermutation(['w', 'a', 'n'], ['n', 'w', 'a'])).toBe(true);
    expect(isFolderPermutation(['w', 'a', 'n'], ['n', 'w'])).toBe(false);
    expect(isFolderPermutation(['w', 'a'], ['w', 'w'])).toBe(false);
    expect(isFolderPermutation(['w', 'a'], ['w', 'x'])).toBe(false);
  });
});

describe('a project from an older server', () => {
  it('becomes one directory with the project’s id as its default, or none when it had no path', () => {
    expect(normalizeProject({ id: 'p1', name: 'Old', path: '/c/old', isGit: true })).toEqual({ id: 'p1', name: 'Old', folders: [{ id: 'p1', path: '/c/old', isGit: true }], defaultFolderId: 'p1' });
    expect(normalizeProject({ id: 'p2', name: 'Blank', path: '', isGit: false })).toEqual({ id: 'p2', name: 'Blank', folders: [], defaultFolderId: null });
  });

  it('keeps a chosen default, and gives one from before explicit defaults its first', () => {
    expect(normalizeProject(several)).toEqual({ ...several, defaultFolderId: 'w' });
    expect(normalizeProject({ ...several, defaultFolderId: 'a' }).defaultFolderId).toBe('a');
    expect(normalizeProject({ ...several, defaultFolderId: 'gone' }).defaultFolderId).toBe('w');
  });
});
