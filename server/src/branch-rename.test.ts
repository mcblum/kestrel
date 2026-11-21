import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { branchRenameRefusal, renameBranch } from './branch-rename.ts';
import { createWorktree } from './git.ts';
import { makeRepo } from './test-repo.ts';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';

// Builds real git repositories: room under a loaded machine (test-timeouts.ts).
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

const ID = '12345678-aaaa-bbbb-cccc-1234567890ab';
const out = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd }).toString().trim();

async function worktree() {
  const repo = makeRepo();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-wt-')));
  const wt = await createWorktree(repo, dir, ID, 'Please look into the upload page', 'kestrel');
  return { repo, wt, to: 'kestrel/debug-upload-page-hang-12345678' };
}

describe('renaming a session branch', () => {
  it('is allowed for a fresh branch, and carries its base and the worktree with it', async () => {
    const { repo, wt, to } = await worktree();
    expect(await branchRenameRefusal(wt.path, wt.branch, to)).toBeNull();
    await renameBranch(repo, wt.branch, to);
    expect(out(wt.path, 'branch', '--show-current')).toBe(to);
    expect(out(repo, 'config', '--get', `branch.${to}.kestrelbase`)).toBe(wt.base);
  });

  it('is refused with the reason when the branch has an upstream', async () => {
    const { wt, to } = await worktree();
    execFileSync('git', ['config', `branch.${wt.branch}.remote`, 'origin'], { cwd: wt.path });
    expect(await branchRenameRefusal(wt.path, wt.branch, to)).toBe('it has an upstream');
  });

  it('is refused when another branch records it as the one it was cut from', async () => {
    const { repo, wt, to } = await worktree();
    execFileSync('git', ['branch', 'child', wt.branch], { cwd: repo });
    execFileSync('git', ['config', 'branch.child.kestrelbaseref', wt.branch], { cwd: repo });
    expect(await branchRenameRefusal(wt.path, wt.branch, to)).toBe('another branch was cut from it');
  });

  it('is refused when the new name is taken', async () => {
    const { repo, wt, to } = await worktree();
    execFileSync('git', ['branch', to], { cwd: repo });
    expect(await branchRenameRefusal(wt.path, wt.branch, to)).toBe(`${to} already exists`);
  });
});
