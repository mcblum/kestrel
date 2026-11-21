// Deleting a session cleans up after it: the worktree folder goes, and so does its branch when
// nothing would be lost with it. A branch with commits found nowhere else is kept.
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import { git } from './git.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { createProject } from './project-store.ts';
import { SessionRuntime } from './runtime.ts';
import { FakeAgents, until } from './test-agent.ts';
import { makeRepo } from './test-repo.ts';
import { Workspace } from './workspace.ts';

// Builds real git repositories: room under a loaded machine (test-timeouts.ts).
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

async function started() {
  const workspace = new Workspace(memoryPersistence());
  const agents = new FakeAgents();
  const runtime = new SessionRuntime(workspace, { claude: agents.adapter() }, realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-delete-'))));
  const repo = makeRepo();
  const project = await createProject(workspace, { name: 'Shop', folders: [repo] });
  const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'work' });
  const view = async () => (await workspace.state()).sessions.find((s) => s.id === session.id)!;
  await until(async () => (await view()).worktreePath !== null, 'the worktree');
  await agents.settled();
  await runtime.idle(session.id);
  const { worktreePath, branch } = await view();
  const branches = async () => (await git(repo, ['branch', '--format=%(refname:short)'])).split('\n').filter(Boolean);
  const commit = async () => {
    writeFileSync(join(worktreePath!, 'work.txt'), 'done\n');
    await git(worktreePath!, ['add', '.']);
    await git(worktreePath!, ['commit', '-m', 'work']);
  };
  return { workspace, runtime, repo, session, worktree: worktreePath!, branch: branch!, branches, commit };
}

describe('deleting a session', () => {
  it('removes the worktree and a branch that holds no work of its own', async () => {
    const w = await started();
    expect(await w.branches()).toContain(w.branch);
    await w.runtime.deleteSession(w.session.id);
    expect(existsSync(w.worktree)).toBe(false);
    expect(await w.branches()).not.toContain(w.branch);
    expect((await w.workspace.state()).sessions).toHaveLength(0);
  });

  it('keeps a branch whose commits are nowhere else', async () => {
    const w = await started();
    await w.commit();
    await w.runtime.deleteSession(w.session.id);
    expect(existsSync(w.worktree)).toBe(false);
    expect(await w.branches()).toContain(w.branch);
  });

  it('removes the branch once its commits are in the main checkout', async () => {
    const w = await started();
    await w.commit();
    await git(w.repo, ['merge', '--no-ff', '-m', 'merge', w.branch]);
    await w.runtime.deleteSession(w.session.id);
    expect(await w.branches()).not.toContain(w.branch);
  });

  it('removes the merged branch of a session whose worktree was already removed', async () => {
    const w = await started();
    await w.runtime.discardWorktree(w.session.id, false);
    expect(await w.branches()).toContain(w.branch);
    await w.runtime.deleteSession(w.session.id);
    expect(await w.branches()).not.toContain(w.branch);
  });
});

describe('at startup', () => {
  it('marks a session whose worktree folder is gone, so the row says so before anyone replies', async () => {
    const w = await started();
    const { rmSync } = await import('node:fs');
    expect(await w.runtime.markLostWorktrees()).toBe(0);
    rmSync(w.worktree, { recursive: true, force: true });
    expect(await w.runtime.markLostWorktrees()).toBe(1);
    const row = (await w.workspace.state()).sessions.find((s) => s.id === w.session.id)!;
    expect(row).toMatchObject({ worktreePath: null, worktreeDiscarded: true, note: 'Its worktree folder is gone' });
    await expect(w.runtime.reply(w.session.id, 'more', {})).rejects.toThrow(/cannot continue/);
    expect(await w.runtime.markLostWorktrees()).toBe(0);
  });

  it('leaves sample sessions alone: their worktrees never existed', async () => {
    const w = await started();
    await w.workspace.addSession({ id: 'sample', title: 'Sample', agent: 'claude', startedIn: null });
    await w.workspace.attachWorktree('sample', { path: '/no/such/worktree', branch: 'kestrel/sample' });
    expect(await w.runtime.markLostWorktrees()).toBe(0);
    expect((await w.workspace.state()).sessions.find((s) => s.id === 'sample')).toMatchObject({ worktreePath: '/no/such/worktree', worktreeDiscarded: false });
  });

  it("forgets worktrees whose folders are gone, in every project's repository", async () => {
    const w = await started();
    const { rmSync } = await import('node:fs');
    rmSync(w.worktree, { recursive: true, force: true });
    expect(await git(w.repo, ['worktree', 'list'])).toContain(w.worktree);
    await w.runtime.pruneWorktrees();
    expect(await git(w.repo, ['worktree', 'list'])).not.toContain(w.worktree);
  });
});
