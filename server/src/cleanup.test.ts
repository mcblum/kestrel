// Cleanup after a merged pull request (shared/cleanup-policy.ts, cleanup/*): the rule, and on a
// real repository a session whose request is seen merged.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cleanupPolicyRoute } from './cleanup/api.ts';
import { unpushedCommits } from './cleanup/on-merge.ts';
import { CleanupPrefs } from './cleanup/prefs.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { runScript } from './project-scripts/run.ts';
import { SessionRuntime } from './runtime.ts';
import { DEFAULT_AUTOPILOT_PREFS, newRecord } from './shared/autopilot.ts';
import { cleanupPlan, GLOBAL_POLICY, mergedNotice, NO_CLEANUP, policyFor, policyProblem, sanitizePolicies, type CleanupPolicy } from './shared/cleanup-policy.ts';
import { FakeAgents } from './test-agent.ts';
import { makeRepo } from './test-repo.ts';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import { Workspace } from './workspace.ts';

vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const tempDir = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `kestrel-${name}-`)));
const ALL: CleanupPolicy = { archive: true, removeWorktree: true, deleteBranch: true };
const CLEAN = { working: false, hasWorktree: true, uncommitted: 0, unpushed: 0 };

describe('the rule', () => {
  it('does what the policy asks when nothing would be lost', () => {
    expect(cleanupPlan(ALL, CLEAN)).toEqual({ archive: true, removeWorktree: true, deleteBranch: true, kept: [] });
    expect(cleanupPlan({ ...NO_CLEANUP, archive: true }, CLEAN)).toEqual({ archive: true, removeWorktree: false, deleteBranch: false, kept: [] });
    expect(cleanupPlan(NO_CLEANUP, CLEAN)).toEqual({ archive: false, removeWorktree: false, deleteBranch: false, kept: [] });
  });

  it('keeps a worktree with uncommitted files, and a branch with commits never pushed, and says so', () => {
    expect(cleanupPlan(ALL, { ...CLEAN, uncommitted: 2 })).toEqual({ archive: true, removeWorktree: false, deleteBranch: false, kept: ['Its worktree was kept: 2 files in it are not committed.'] });
    expect(cleanupPlan(ALL, { ...CLEAN, unpushed: 1 })).toEqual({ archive: true, removeWorktree: true, deleteBranch: false, kept: ['Its branch was kept: 1 commit on it was never pushed.'] });
  });

  it('leaves a session that is still working, and one with no worktree only archives', () => {
    expect(cleanupPlan(ALL, { ...CLEAN, working: true })).toEqual({ archive: false, removeWorktree: false, deleteBranch: false, kept: [] });
    expect(cleanupPlan(ALL, { ...CLEAN, hasWorktree: false })).toEqual({ archive: true, removeWorktree: false, deleteBranch: false, kept: [] });
  });

  it('tells the session what was done and what was kept', () => {
    expect(mergedNotice(cleanupPlan(ALL, CLEAN))).toBe('Its pull request was merged, so Kestrel archived this session, removed its worktree and deleted its local branch.');
    expect(mergedNotice(cleanupPlan(ALL, { ...CLEAN, uncommitted: 1 }))).toBe('Its pull request was merged, so Kestrel archived this session. Its worktree was kept: 1 file in it is not committed.');
    expect(mergedNotice(cleanupPlan(NO_CLEANUP, CLEAN))).toBeNull();
  });

  it('follows a project’s own policy over the app-wide one, and never deletes a branch without its worktree', () => {
    const all = sanitizePolicies({ [GLOBAL_POLICY]: { archive: true }, p: { archive: false, removeWorktree: false, deleteBranch: true } });
    expect(policyFor(all, 'other')).toEqual({ archive: true, removeWorktree: false, deleteBranch: false });
    expect(policyFor(all, 'p')).toEqual(NO_CLEANUP);
    expect(policyFor({}, 'p')).toEqual(NO_CLEANUP);
    expect(policyProblem({ archive: true, removeWorktree: false, deleteBranch: true })).toMatch(/only with its worktree removed/);
    expect(policyProblem({ archive: true })).toMatch(/Send archive, removeWorktree and deleteBranch/);
    expect(policyProblem(ALL)).toBeNull();
  });
});

describe('a session whose pull request is merged', () => {
  async function world() {
    const workspace = new Workspace(memoryPersistence());
    const agents = new FakeAgents();
    const shellEnv = { SHELL: '/bin/sh', PATH: process.env.PATH, HOME: tempDir('home') };
    const runtime = new SessionRuntime(workspace, { claude: agents.adapter() }, tempDir('data'), { projectScripts: { run: (run) => runScript({ ...run, env: shellEnv }) } });
    const repo = makeRepo();
    const bare = join(tempDir('remote'), 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    git(repo, 'remote', 'add', 'origin', bare);
    git(repo, 'push', '-q', '-u', 'origin', 'main');
    const project = await runtime.registerProject(repo, 'app');
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Fix it' });
    await runtime.idle(session.id);
    const row = async () => {
      const s = await workspace.state();
      return s.sessions.find((x) => x.id === session.id) ?? s.archived.sessions.find((x) => x.id === session.id)!;
    };
    const { worktreePath, branch } = await row();
    /** One commit on the session's branch, pushed or not. */
    const commit = (push: boolean) => {
      writeFileSync(join(worktreePath!, 'fix.txt'), 'fixed\n');
      git(worktreePath!, 'add', '.');
      git(worktreePath!, 'commit', '-q', '-m', 'fix');
      if (push) git(worktreePath!, 'push', '-q', '-u', 'origin', branch!);
    };
    /** The host now says the request is merged, as the pull request sync would record it. */
    const merge = async () => {
      await workspace.recordRequests(session.id, [{ host: 'github', number: 7, url: 'https://example.test/pr/7', state: 'open' } as never]);
      await workspace.recordRequests(session.id, [{ host: 'github', number: 7, url: 'https://example.test/pr/7', state: 'merged' } as never]);
      return runtime.mergeCleanup.merged(session.id);
    };
    const archived = async () => (await workspace.state()).archived.sessions.some((s) => s.id === session.id);
    const notices = () => runtime.overlay(session.id)?.messages.filter((m) => m.notice).map((m) => m.text) ?? [];
    return { runtime, workspace, repo, project, session, worktree: worktreePath!, branch: branch!, commit, merge, archived, row, notices };
  }

  it('is left alone until a policy is set', async () => {
    const { merge, archived, worktree } = await world();
    expect(await merge()).toBeNull();
    expect(await archived()).toBe(false);
    expect(existsSync(worktree)).toBe(true);
  });

  it('is archived, its worktree removed and its pushed branch deleted, and is told so', async () => {
    const { runtime, repo, commit, merge, archived, worktree, branch, row, notices } = await world();
    await runtime.cleanupPrefs.set(GLOBAL_POLICY, ALL);
    commit(true);
    expect(await unpushedCommits(repo, branch)).toBe(0);
    expect(await merge()).toEqual({ archive: true, removeWorktree: true, deleteBranch: true, kept: [] });
    expect(await archived()).toBe(true);
    expect(existsSync(worktree)).toBe(false);
    expect(git(repo, 'branch', '--list', branch)).toBe('');
    expect((await row()).worktreeDiscarded).toBe(true);
    expect(notices()).toContain('Its pull request was merged, so Kestrel archived this session, removed its worktree and deleted its local branch.');
  });

  it('waits while Autopilot watches the target branch\'s pipeline, and goes ahead once that ends quietly', async () => {
    const { runtime, workspace, session, commit, archived, worktree } = await world();
    await runtime.cleanupPrefs.set(GLOBAL_POLICY, ALL);
    commit(true);
    await workspace.setAutopilot(session.id, { ...newRecord(7, { merge: false, watch: true }, DEFAULT_AUTOPILOT_PREFS) });
    const cleanups = vi.spyOn(runtime.mergeCleanup, 'merged');
    // The sync records the request merged: the clean-up the policy asks for is held, since a failure there needs the worktree.
    await workspace.recordRequests(session.id, [{ host: 'github', number: 7, url: 'https://example.test/pr/7', state: 'open' } as never]);
    await workspace.recordRequests(session.id, [{ host: 'github', number: 7, url: 'https://example.test/pr/7', state: 'merged' } as never]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cleanups).not.toHaveBeenCalled();
    expect(await archived()).toBe(false);
    expect(existsSync(worktree)).toBe(true);
    // The pipeline passed (the watcher's `watchEnded`): the held clean-up runs.
    (runtime as unknown as { cleanUpHeld(id: string): void }).cleanUpHeld(session.id);
    expect(cleanups).toHaveBeenCalledWith(session.id);
    await vi.waitFor(async () => expect(await archived()).toBe(true));
    expect(existsSync(worktree)).toBe(false);
  });

  it('keeps a worktree with uncommitted files, and still archives', async () => {
    const { runtime, merge, archived, worktree, notices } = await world();
    await runtime.cleanupPrefs.set(GLOBAL_POLICY, ALL);
    writeFileSync(join(worktree, 'draft.txt'), 'not committed\n');
    expect(await merge()).toMatchObject({ archive: true, removeWorktree: false, deleteBranch: false });
    expect(existsSync(join(worktree, 'draft.txt'))).toBe(true);
    expect(await archived()).toBe(true);
    expect(notices().at(-1)).toMatch(/Its worktree was kept: 1 file in it is not committed\./);
  });

  it('keeps a branch with a commit that was never pushed, but removes the clean worktree', async () => {
    const { runtime, repo, commit, merge, worktree, branch } = await world();
    await runtime.cleanupPrefs.set(GLOBAL_POLICY, ALL);
    commit(false);
    expect(await merge()).toMatchObject({ removeWorktree: true, deleteBranch: false, kept: ['Its branch was kept: 1 commit on it was never pushed.'] });
    expect(existsSync(worktree)).toBe(false);
    expect(git(repo, 'branch', '--list', branch)).not.toBe('');
  });

  it('follows the project’s own policy, and stops when the archive script fails', async () => {
    const { runtime, project, merge, archived, worktree, notices } = await world();
    await runtime.cleanupPrefs.set(GLOBAL_POLICY, ALL);
    await runtime.cleanupPrefs.set(project.id, { archive: true, removeWorktree: true, deleteBranch: false });
    await runtime.projectScripts.scripts.set(project.id, { setup: '', archive: 'echo port busy; exit 4' });
    expect(await merge()).toMatchObject({ archive: false, removeWorktree: false });
    expect(await archived()).toBe(false);
    expect(existsSync(worktree)).toBe(true);
    expect(notices().at(-1)).toBe('Its pull request was merged. The project\'s archive script failed (exit 4). It was not archived, and its worktree was left as it is.');
  });

  it('serves and stores the policies over HTTP, a project’s own and the way back to the app-wide one', async () => {
    const { project } = await world();
    const workspace = { state: async () => ({ projects: [{ id: project.id }] }) } as never;
    const prefs = new CleanupPrefs();
    const route = (method: string, body: Record<string, unknown> = {}) => cleanupPolicyRoute(['api', 'cleanup-policy'], method, async () => body, workspace, prefs);
    expect(await route('GET')).toEqual({ status: 200, body: { policies: {} } });
    expect(await route('PUT', { scope: 'nope', policy: ALL })).toEqual({ status: 400, body: { error: 'No such project.' } });
    expect(await route('PUT', { scope: GLOBAL_POLICY, policy: { archive: true, removeWorktree: false, deleteBranch: true } })).toMatchObject({ status: 400 });
    expect(await route('PUT', { scope: GLOBAL_POLICY, policy: ALL })).toEqual({ status: 200, body: { policies: { '*': ALL } } });
    expect(await route('PUT', { scope: project.id, policy: NO_CLEANUP })).toEqual({ status: 200, body: { policies: { '*': ALL, [project.id]: NO_CLEANUP } } });
    expect(await route('PUT', { scope: project.id, policy: null })).toEqual({ status: 200, body: { policies: { '*': ALL } } });
    expect(await route('PUT', { scope: GLOBAL_POLICY, policy: null })).toMatchObject({ status: 400 });
  });
});
