import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import { createWorktree } from './git.ts';
import { makeRepo } from './test-repo.ts';
import { discardWorktreeFolder, parseCommitLines, porcelainPaths, previewDiscard } from './worktree-landing.ts';

// Builds real git repositories: room under a loaded machine (test-timeouts.ts).
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd }).toString().trim();
function commit(cwd: string, file: string, text: string, message: string): void {
  writeFileSync(join(cwd, file), text);
  sh(cwd, 'add', '.');
  sh(cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', message);
}
async function setup() {
  const repo = makeRepo();
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-data-')));
  const wt = await createWorktree(repo, join(data, 'worktrees'), 'aaaaaaaa-1', 'Land me', 'kestrel');
  return { repo, wt };
}

describe('parsing', () => {
  it('reads commit lines and porcelain paths', () => {
    expect(parseCommitLines('abc first line\ndef second\n')).toEqual([{ sha: 'abc', subject: 'first line' }, { sha: 'def', subject: 'second' }]);
    expect(porcelainPaths(' M a.txt\0?? new dir/b.txt\0')).toEqual(['a.txt', 'new dir/b.txt']);
  });
});

describe('discarding a worktree', () => {
  it('says what is lost, then removes the folder and keeps the branch', async () => {
    const { repo, wt } = await setup();
    commit(wt.path, 'b.txt', 'b\n', 'Add b');
    writeFileSync(join(wt.path, 'draft.txt'), 'x\n');
    const preview = await previewDiscard(repo, wt.path, wt.branch);
    expect(preview).toMatchObject({ uncommitted: ['draft.txt'], target: 'main', totalUnmerged: 1 });
    await discardWorktreeFolder(repo, wt.path, wt.branch, false);
    expect(existsSync(wt.path)).toBe(false);
    expect(sh(repo, 'branch', '--list', wt.branch)).toContain(wt.branch);
  });

  it('deletes the branch when asked', async () => {
    const { repo, wt } = await setup();
    await discardWorktreeFolder(repo, wt.path, wt.branch, true);
    expect(sh(repo, 'branch', '--list', wt.branch)).toBe('');
  });
});
