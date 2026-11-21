import { describe, expect, it } from 'vitest';
import { noFolderReason, scopeFolder, type ScopeFolderSource } from './scope-folder.ts';
import { terminalFolder } from './terminal-socket.ts';

const source: ScopeFolderSource = {
  sessionFolder: async (id) => (id === 's1' ? '/worktrees/s1' : null),
  projectFolder: async (id) => (id === 'p1' ? '/code/p1' : null),
};

describe('a scope\'s folder', () => {
  it('is a session\'s working folder, by its bare id or session: spelling', async () => {
    expect(await scopeFolder('s1', source)).toBe('/worktrees/s1');
    expect(await scopeFolder('session:s1', source)).toBe('/worktrees/s1');
  });

  it('is a project\'s own folder', async () => {
    expect(await scopeFolder('project:p1', source)).toBe('/code/p1');
    expect(await scopeFolder('project:nope', source)).toBeNull();
  });

  it('does not exist for a group or anything that is not a scope', async () => {
    expect(await scopeFolder('group:g1', source)).toBeNull();
    expect(await scopeFolder('planet:x', source)).toBeNull();
  });

  it('says why there is none', () => {
    expect(noFolderReason('group:g1')).toBe('A group has no folder.');
    expect(noFolderReason('project:p1')).toMatch(/project/);
    expect(noFolderReason('s1')).toMatch(/session/);
  });

  it('gives a group\'s terminal the home folder, and everything else its own folder', async () => {
    const folderOf = (key: string) => scopeFolder(key, source);
    expect(await terminalFolder('group:g1', folderOf, '/Users/me')).toBe('/Users/me');
    expect(await terminalFolder('project:p1', folderOf, '/Users/me')).toBe('/code/p1');
    expect(await terminalFolder('s9', folderOf, '/Users/me')).toBeNull();
  });
});
