// Where a new session starts when the project's checkout is not on its default branch
// (shared/start-base.ts, start-base/*, base-refresh.ts `startFromDefault`), on real repositories with
// a local bare repository as the remote.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BaseRefresh, defaultStartNotice } from './base-refresh.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { SessionRuntime } from './runtime.ts';
import { describeBaseQuestion, effectiveBase, sanitizeStartBasePrefs, type BaseQuestion } from './shared/start-base.ts';
import { baseQuestion, startBaseRoute } from './start-base/api.ts';
import { checkoutState, defaultBranchOf } from './start-base/check.ts';
import { StartBase } from './start-base/prefs.ts';
import { FakeAgents } from './test-agent.ts';
import { makeRepo } from './test-repo.ts';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import { Workspace } from './workspace.ts';

// Builds real git repositories: room under a loaded machine (test-timeouts.ts).
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const tempDir = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `kestrel-${name}-`)));

function commit(cwd: string, file: string, text: string): string {
  writeFileSync(join(cwd, file), text);
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', `edit ${file}`);
  return git(cwd, 'rev-parse', 'HEAD');
}

/**
 * A checkout whose default branch is `production` on a bare remote (origin/HEAD points at it), now
 * on a feature branch with one commit of its own; another clone pushes newer commits to production.
 */
function onFeatureBranch() {
  const bare = join(tempDir('remote'), 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'production', bare]);
  const repo = makeRepo();
  git(repo, 'branch', '-m', 'production');
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '-q', '-u', 'origin', 'production');
  git(repo, 'remote', 'set-head', 'origin', 'production');
  git(repo, 'switch', '-q', '-c', 'feat/old');
  const feature = commit(repo, 'feature.txt', 'mine\n');
  const other = join(tempDir('other'), 'clone');
  execFileSync('git', ['clone', '-q', bare, other], { stdio: 'ignore' });
  const pushNewer = (count: number) => {
    for (let i = 0; i < count; i++) commit(other, 'b.txt', `newer ${i}\n`);
    git(other, 'push', '-q', 'origin', 'production');
    return git(other, 'rev-parse', 'HEAD');
  };
  return { repo, feature, pushNewer };
}

describe('the checkout compared with its default branch', () => {
  it('finds the default branch from origin/HEAD, else main or master', async () => {
    const { repo } = onFeatureBranch();
    expect(await defaultBranchOf(repo)).toEqual({ name: 'production', ref: 'refs/remotes/origin/production' });
    expect(await defaultBranchOf(makeRepo())).toEqual({ name: 'main', ref: 'refs/heads/main' });
  });

  it('says nothing on the default branch, and what differs on another', async () => {
    const { repo, pushNewer } = onFeatureBranch();
    git(repo, 'switch', '-q', 'production');
    expect(await checkoutState(repo)).toBeNull();
    git(repo, 'switch', '-q', 'feat/old');
    pushNewer(2);
    git(repo, 'fetch', '-q', 'origin');
    writeFileSync(join(repo, 'a.txt'), 'changed\n');
    expect(await checkoutState(repo)).toEqual({ branch: 'feat/old', defaultBranch: 'production', ahead: 1, behind: 2, contained: false, uncommitted: 1 });
  });

  it('names a detached HEAD, and a branch with nothing of its own as contained', async () => {
    const repo = makeRepo();
    git(repo, 'switch', '-q', '-c', 'merged-already');
    expect(await checkoutState(repo)).toMatchObject({ branch: 'merged-already', ahead: 0, behind: 0, contained: true });
    git(repo, 'switch', '-q', '--detach', 'main');
    expect(await checkoutState(repo)).toMatchObject({ branch: null, defaultBranch: 'main' });
  });
});

describe('the question in words', () => {
  const q: BaseQuestion = { projectId: 'p', projectName: 'configuration-management', branch: 'ha/litter', defaultBranch: 'production_2026', ahead: 1, behind: 12, contained: false, uncommitted: 2 };

  it('says where the checkout is and what each choice leaves out', () => {
    expect(describeBaseQuestion(q)).toEqual({
      summary: 'configuration-management is on ha/litter, not production_2026.',
      notes: ['It is 12 commits behind production_2026.', 'It has 1 commit that production_2026 does not. Starting from production_2026 leaves them out.', '2 files changed in the checkout and not committed. Neither choice brings them into the new worktree.'],
    });
    expect(describeBaseQuestion({ ...q, ahead: 0, contained: true, uncommitted: 0, behind: 1 }).notes).toEqual(['Everything on it is already in production_2026, which has 1 commit more.']);
  });

  it('keeps only readable remembered answers, and the asked one wins', () => {
    expect(sanitizeStartBasePrefs({ a: 'default', b: 'current', c: 'nope', '': 'default' })).toEqual({ a: 'default', b: 'current' });
    expect(sanitizeStartBasePrefs(['default'])).toEqual({});
    expect(effectiveBase('current', 'default', 'default')).toBe('current');
    expect(effectiveBase(undefined, 'current', 'default')).toBe('current');
    expect(effectiveBase(undefined, undefined, 'default')).toBe('default');
  });
});

describe('starting from the latest default branch', () => {
  it('cuts from the remote default branch’s newest tip, whatever the checkout is on, and leaves the checkout alone', async () => {
    const { repo, feature, pushNewer } = onFeatureBranch();
    const newest = pushNewer(3);
    const refresh = new BaseRefresh({ enabled: async () => true });
    expect(await refresh.startFromDefault(repo)).toEqual({ start: { head: newest, base: newest, baseRef: 'production' }, notice: { text: defaultStartNotice('production'), level: 'info' } });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(feature);
    expect(git(repo, 'branch', '--show-current')).toBe('feat/old');
  });

  it('does not fetch with the setting off, and keeps a local default branch with commits of its own', async () => {
    const { repo, pushNewer } = onFeatureBranch();
    const known = git(repo, 'rev-parse', 'refs/remotes/origin/production');
    pushNewer(1);
    expect((await new BaseRefresh({ enabled: async () => false }).startFromDefault(repo)).start?.head).toBe(known);
    git(repo, 'switch', '-q', 'production');
    const local = commit(repo, 'local.txt', 'mine\n');
    git(repo, 'switch', '-q', 'feat/old');
    expect((await new BaseRefresh({ enabled: async () => true }).startFromDefault(repo)).start?.head).toBe(local);
  });
});

describe('a new session in a checkout off its default branch', () => {
  async function world() {
    const workspace = new Workspace(memoryPersistence());
    const agents = new FakeAgents();
    const runtime = new SessionRuntime(workspace, { claude: agents.adapter() }, tempDir('data'));
    const checkout = onFeatureBranch();
    const project = await runtime.registerProject(checkout.repo, 'cm');
    const headOf = async (id: string) => {
      await runtime.idle(id);
      const session = (await workspace.state()).sessions.find((s) => s.id === id)!;
      return git(session.worktreePath!, 'rev-parse', 'HEAD');
    };
    return { workspace, runtime, project, headOf, ...checkout };
  }

  it('starts from the default branch or the checkout, as answered', async () => {
    const { runtime, project, headOf, feature, pushNewer } = await world();
    const newest = pushNewer(1);
    const fromDefault = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Fix it', base: 'default' });
    expect(await headOf(fromDefault.id)).toBe(newest);
    const asItIs = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Fix it', base: 'current' });
    expect(await headOf(asItIs.id)).toBe(feature);
  });

  it('asks until an answer is remembered, then uses it without asking', async () => {
    const { workspace, runtime, project, headOf, pushNewer } = await world();
    expect(await baseQuestion(workspace, runtime.startBase, project.id, null)).toMatchObject({ projectName: 'cm', branch: 'feat/old', defaultBranch: 'production', ahead: 1 });
    await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Fix it', base: 'default', rememberBase: true });
    expect(await runtime.startBase.prefs()).toEqual({ [project.id]: 'default' });
    expect(await baseQuestion(workspace, runtime.startBase, project.id, null)).toBeNull();
    const newest = pushNewer(1);
    const unasked = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Fix it' });
    expect(await headOf(unasked.id)).toBe(newest);
  });

  it('starts an agent’s child from the default branch when nothing is remembered', async () => {
    const { workspace, runtime, project, headOf, pushNewer } = await world();
    const newest = pushNewer(1);
    const child = await workspace.addSession({ title: 'Child', agent: 'claude', startedIn: project.id, state: 'running' });
    expect(await runtime.launchChild(child, project, project.folders[0]!, 'Do the part', 'spawn', '', 'ask')).toEqual({ ok: true });
    expect(await headOf(child.id)).toBe(newest);
  });

  it('serves the check and the remembered answers over HTTP, and refuses a bad choice with the reason', async () => {
    const { workspace, runtime, project } = await world();
    const route = (parts: string[], method: string, body: Record<string, unknown> = {}) => startBaseRoute(parts, method, async () => body, workspace, runtime.startBase);
    expect(await route(['api', 'start-base', 'check'], 'POST', { projectId: project.id })).toMatchObject({ status: 200, body: { question: { branch: 'feat/old' } } });
    expect(await route(['api', 'start-base'], 'PUT', { projectId: project.id, choice: 'sideways' })).toEqual({ status: 400, body: { error: 'choice must be "default", "current" or null.' } });
    expect(await route(['api', 'start-base'], 'PUT', { projectId: project.id, choice: 'current' })).toEqual({ status: 200, body: { prefs: { [project.id]: 'current' } } });
    expect(await route(['api', 'start-base'], 'PUT', { projectId: project.id, choice: null })).toEqual({ status: 200, body: { prefs: {} } });
    expect(await route(['api', 'other'], 'GET')).toBeNull();
  });

  it('forgets a remembered answer when asked to', async () => {
    const prefs = new StartBase();
    await prefs.remember('p', 'current');
    expect(await prefs.remember('p', null)).toEqual({});
  });
});
