import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeRepo } from './test-repo.ts';
import { gitFolders, worktreeRepo } from './worktree-repo.ts';

describe('the folders git writes for a checkout', () => {
  it('is its own .git for a repository', () => {
    const repo = makeRepo();
    expect(gitFolders(repo)).toEqual([join(repo, '.git')]);
  });

  it('is the repository’s .git and the worktree’s own folder under it for a linked worktree', () => {
    const repo = makeRepo();
    const worktree = `${repo}-wt`;
    execFileSync('git', ['worktree', 'add', '-q', worktree, '-b', 'wt'], { cwd: repo, stdio: 'ignore' });
    expect(worktreeRepo(worktree)).toBe(repo);
    expect(gitFolders(worktree)).toEqual([join(repo, '.git'), join(repo, '.git', 'worktrees', basename(worktree))]);
  });

  it('is nothing for a plain folder, or one that is not there', () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-plain-')));
    expect(gitFolders(plain)).toEqual([]);
    expect(gitFolders(join(plain, 'missing'))).toEqual([]);
  });
});
