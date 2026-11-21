// A project's Git defaults (shared/git-defaults.ts, git-defaults/*): the rules, and on real
// repositories with two remotes, which branch is the base and where a new session starts.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BaseRefresh, defaultStartNotice } from './base-refresh.ts';
import { gitChoices, gitDefaultsRoute } from './git-defaults/api.ts';
import { GitDefaultsPrefs } from './git-defaults/prefs.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { SessionRuntime } from './runtime.ts';
import { gitDefaultsProblem, gitNameProblem, missingBaseNotice, sanitizeGitDefaultsByProject, withGitDefaults } from './shared/git-defaults.ts';
import { baseQuestion } from './start-base/api.ts';
import { checkoutState, defaultBranchOf } from './start-base/check.ts';
import { FakeAgents } from './test-agent.ts';
import { makeRepo } from './test-repo.ts';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import { Workspace } from './workspace.ts';

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
 * A checkout on `main` with two remotes: `origin` (HEAD: main) and `upstream`, which also has a
 * `develop` branch one commit ahead that the checkout has never fetched. `pushDevelop` adds more.
 */
function twoRemotes() {
  const bare = (name: string) => {
    const path = join(tempDir(name), `${name}.git`);
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', path]);
    return path;
  };
  const origin = bare('origin');
  const upstream = bare('upstream');
  const repo = makeRepo();
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'remote', 'add', 'upstream', upstream);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'push', '-q', 'upstream', 'main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  const other = join(tempDir('other'), 'clone');
  execFileSync('git', ['clone', '-q', upstream, other], { stdio: 'ignore' });
  git(other, 'switch', '-q', '-c', 'develop');
  const pushDevelop = () => {
    const sha = commit(other, 'd.txt', `${Math.random()}\n`);
    git(other, 'push', '-q', 'origin', 'develop');
    return sha;
  };
  return { repo, develop: pushDevelop(), pushDevelop };
}

describe('the rules', () => {
  it('takes names git takes, and says why it refuses the others', () => {
    expect(gitNameProblem('', 'branch')).toBeNull();
    expect(gitNameProblem('release/2026.11', 'branch')).toBeNull();
    expect(gitNameProblem('-x', 'branch')).toBe('A branch name cannot start with "-".');
    expect(gitNameProblem('my branch', 'branch')).toBe('"my branch" is not a name git accepts for a branch.');
    expect(gitNameProblem('a..b', 'branch')).toMatch(/not a name git accepts/);
    expect(gitNameProblem('up/stream', 'remote')).toBe('A remote name cannot contain "/".');
    expect(gitDefaultsProblem({ baseBranch: 'develop', remote: 'upstream' })).toBeNull();
    expect(gitDefaultsProblem({ baseBranch: 'develop' })).toBe('Send baseBranch and remote as text; empty for automatic.');
  });

  it('keeps only projects with something chosen', () => {
    expect(sanitizeGitDefaultsByProject({ a: { baseBranch: ' develop ', remote: '' }, b: { baseBranch: '', remote: '' }, c: { baseBranch: 'bad name', remote: 'upstream' } })).toEqual({ a: { baseBranch: 'develop', remote: '' }, c: { baseBranch: '', remote: 'upstream' } });
    expect(withGitDefaults({ a: { baseBranch: 'develop', remote: '' } }, 'a', { baseBranch: '', remote: '' })).toEqual({});
  });
});

describe('which branch is the base', () => {
  it('is the remote’s own default when nothing is chosen, and the chosen branch and remote when they are', async () => {
    const { repo } = twoRemotes();
    expect(await defaultBranchOf(repo)).toEqual({ name: 'main', ref: 'refs/remotes/origin/main' });
    git(repo, 'fetch', '-q', 'upstream');
    expect(await defaultBranchOf(repo, { baseBranch: 'develop', remote: 'upstream' })).toEqual({ name: 'develop', ref: 'refs/remotes/upstream/develop' });
    expect(await defaultBranchOf(repo, { baseBranch: '', remote: 'upstream' })).toEqual({ name: 'main', ref: 'refs/remotes/upstream/main' });
    expect(await defaultBranchOf(repo, { baseBranch: 'nowhere', remote: '' })).toBeNull();
  });

  it('asks about a checkout that is on main when the project’s base is another branch', async () => {
    const { repo } = twoRemotes();
    git(repo, 'fetch', '-q', 'upstream');
    expect(await checkoutState(repo)).toBeNull();
    expect(await checkoutState(repo, { baseBranch: 'develop', remote: 'upstream' })).toMatchObject({ branch: 'main', defaultBranch: 'develop', ahead: 0, behind: 1 });
  });

  it('lists what the repository offers', async () => {
    const { repo } = twoRemotes();
    git(repo, 'fetch', '-q', 'upstream');
    expect(await gitChoices(repo, 'upstream')).toEqual({ remotes: ['origin', 'upstream'], branches: ['develop', 'main'], automaticBranch: 'main' });
    expect((await gitChoices(repo, 'origin')).branches).toEqual(['main']);
    // A session's branch, checked out in its own worktree, is not offered as a base.
    git(repo, 'worktree', 'add', '-q', '-b', 'kestrel/a-session', join(tempDir('wt'), 'w'));
    git(repo, 'branch', 'release');
    expect((await gitChoices(repo, 'origin')).branches).toEqual(['main', 'release']);
  });
});

describe('where a new session starts', () => {
  it('fetches the chosen branch from the chosen remote, even one never fetched before', async () => {
    const { repo, develop, pushDevelop } = twoRemotes();
    const refresh = new BaseRefresh({ enabled: async () => true, reuseMs: 0 });
    const chosen = { baseBranch: 'develop', remote: 'upstream' };
    expect(await refresh.startFromDefault(repo, chosen)).toEqual({ start: { head: develop, base: develop, baseRef: 'develop' }, notice: { text: defaultStartNotice('develop'), level: 'info' } });
    const newer = pushDevelop();
    expect((await refresh.startFromDefault(repo, chosen)).start?.head).toBe(newer);
  });

  it('says so, and starts from the checkout, when the chosen branch is nowhere', async () => {
    const { repo } = twoRemotes();
    const refresh = new BaseRefresh({ enabled: async () => true });
    expect(await refresh.startFromDefault(repo, { baseBranch: 'gone', remote: 'upstream' })).toEqual({ notice: { text: missingBaseNotice('gone', 'upstream'), level: 'warning' } });
  });

  it('starts a project’s session from its chosen base, and asks the start question against it', async () => {
    const { repo, develop } = twoRemotes();
    const workspace = new Workspace(memoryPersistence());
    const runtime = new SessionRuntime(workspace, { claude: new FakeAgents().adapter() }, tempDir('data'));
    const project = await runtime.registerProject(repo, 'cm');
    await runtime.gitDefaults.set(project.id, { baseBranch: 'develop', remote: 'upstream' });
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Fix it', base: 'default' });
    await runtime.idle(session.id);
    const worktree = (await workspace.state()).sessions.find((s) => s.id === session.id)!.worktreePath!;
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(develop);
    expect(await baseQuestion(workspace, runtime.startBase, project.id, null, await runtime.gitDefaults.of(project.id))).toMatchObject({ branch: 'main', defaultBranch: 'develop' });
    expect(await baseQuestion(workspace, runtime.startBase, project.id, null)).toBeNull();
  });
});

describe('over HTTP', () => {
  it('serves and stores a project’s defaults and its choices, and refuses an unknown project or a bad name', async () => {
    const { repo } = twoRemotes();
    const workspace = new Workspace(memoryPersistence());
    const runtime = new SessionRuntime(workspace, {}, tempDir('data'));
    const project = await runtime.registerProject(repo, 'cm');
    const prefs = new GitDefaultsPrefs();
    const route = (parts: string[], method: string, body: Record<string, unknown> = {}, query = '') => gitDefaultsRoute(parts, method, new URLSearchParams(query), async () => body, workspace, prefs);
    expect(await route(['api', 'git-defaults'], 'GET')).toEqual({ status: 200, body: { defaults: {} } });
    expect(await route(['api', 'git-defaults'], 'PUT', { projectId: 'nope', baseBranch: '', remote: '' })).toEqual({ status: 400, body: { error: 'No such project.' } });
    expect(await route(['api', 'git-defaults'], 'PUT', { projectId: project.id, baseBranch: 'a b', remote: '' })).toEqual({ status: 400, body: { error: '"a b" is not a name git accepts for a branch.' } });
    expect(await route(['api', 'git-defaults'], 'PUT', { projectId: project.id, baseBranch: 'develop', remote: 'upstream' })).toEqual({ status: 200, body: { defaults: { [project.id]: { baseBranch: 'develop', remote: 'upstream' } } } });
    expect(await route(['api', 'git-defaults', 'choices'], 'GET', {}, `project=${project.id}`)).toMatchObject({ status: 200, body: { remotes: ['origin', 'upstream'] } });
    expect(await route(['api', 'git-defaults', 'choices'], 'GET', {}, 'project=nope')).toEqual({ status: 400, body: { error: 'That project has no git repository.' } });
    expect(await route(['api', 'other'], 'GET')).toBeNull();
  });
});
