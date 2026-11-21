// The environment settings (shared/project-env.ts, project-env/*): the rules, real .env files and
// real repositories, and what a session's agent and setup script get.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { memoryPersistence } from './persistence/memory.ts';
import { projectEnvRoute } from './project-env/api.ts';
import { ProjectEnvPrefs } from './project-env/prefs.ts';
import { copiedNotice, copyIntoWorktree, resolveEnv } from './project-env/resolve.ts';
import { runScript } from './project-scripts/run.ts';
import { SessionRuntime } from './runtime.ts';
import { copyPatternProblem, envProblem, GLOBAL_ENV, parseVars, sanitizeEnvByScope, textList, usableVars, withEnv, type EnvByScope } from './shared/project-env.ts';
import { FakeAgents } from './test-agent.ts';
import { makeRepo } from './test-repo.ts';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import { Workspace } from './workspace.ts';

vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

const tempDir = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `kestrel-${name}-`)));
const put = (dir: string, file: string, text: string) => {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), text);
};

describe('the rules', () => {
  it('reads NAME=value lines, with comments, export and quotes, and the last one wins', () => {
    expect(parseVars('# local\nexport API_URL="http://localhost:3000"\nDEBUG=1\n\nDEBUG=app:*\nEMPTY=')).toEqual({ vars: { API_URL: 'http://localhost:3000', DEBUG: 'app:*', EMPTY: '' }, problems: [] });
  });

  it('says which line is wrong and why, and never sets one of Kestrel’s own variables', () => {
    expect(parseVars('JUSTAWORD\n1BAD=x\nKESTREL_TOKEN=x').problems).toEqual([
      'Line 1: write it as NAME=value.',
      'Line 2: "1BAD" is not a variable name (letters, digits and _, not starting with a digit).',
      'Line 3: KESTREL_TOKEN is one of Kestrel\'s own variables and cannot be set here.',
    ]);
    expect(usableVars({ OK: '1', KESTREL_PORT: '9', 'bad name': 'x' })).toEqual({ OK: '1' });
  });

  it('keeps files to copy inside the project’s folder', () => {
    expect(copyPatternProblem('.env.local')).toBeNull();
    expect(copyPatternProblem('config/**/*.local.json')).toBeNull();
    expect(copyPatternProblem('/etc/passwd')).toBe('"/etc/passwd" must be relative to the project\'s folder.');
    expect(copyPatternProblem('../other/.env')).toBe('"../other/.env" reaches outside the project\'s folder.');
  });

  it('refuses settings it cannot use, with the reason, and keeps only scopes with something set', () => {
    expect(envProblem({ vars: 'A=1', files: [], copy: ['.env'] })).toBeNull();
    expect(envProblem({ vars: 'A', files: [], copy: [] })).toBe('Line 1: write it as NAME=value.');
    expect(envProblem({ vars: '', files: [], copy: ['../x'] })).toMatch(/reaches outside/);
    expect(envProblem({ vars: '' })).toMatch(/Send vars/);
    expect(sanitizeEnvByScope({ a: { vars: 'A=1', files: [' .env ', '.env'], copy: ['/abs'] }, b: { vars: ' ', files: [], copy: [] } })).toEqual({ a: { vars: 'A=1', files: ['.env'], copy: [] } });
    expect(withEnv({ a: { vars: 'A=1', files: [], copy: [] } }, 'a', { vars: '', files: [], copy: [] })).toEqual({});
    expect(textList(' .env\n\n config/local.json ')).toEqual(['.env', 'config/local.json']);
  });
});

describe('the variables a session gets', () => {
  it('reads .env files and variables, the project’s over the app-wide ones, variables over files', async () => {
    const root = tempDir('root');
    const home = tempDir('home');
    put(home, 'shared.env', 'REGION=eu\nTOKEN=from-home\nKESTREL_TOKEN=nope\n');
    put(root, '.env', 'TOKEN=from-project-file\nPORT=3000\n');
    const all: EnvByScope = { [GLOBAL_ENV]: { vars: 'REGION=us\nLOG=info', files: ['~/shared.env'], copy: [] }, p: { vars: 'PORT=4000', files: ['.env'], copy: [] } };
    expect(await resolveEnv(all, 'p', root, home)).toEqual({ env: { REGION: 'us', TOKEN: 'from-project-file', LOG: 'info', PORT: '4000' }, problems: [] });
    expect((await resolveEnv(all, 'other', root, home)).env).toEqual({ REGION: 'us', TOKEN: 'from-home', LOG: 'info' });
  });

  it('says which file could not be read, and still gives the rest', async () => {
    const all: EnvByScope = { [GLOBAL_ENV]: { vars: 'A=1', files: ['missing.env'], copy: [] } };
    expect(await resolveEnv(all, 'p', tempDir('root'))).toEqual({ env: { A: '1' }, problems: ['The .env file missing.env could not be read: it does not exist.'] });
    expect((await resolveEnv(all, null, null)).problems).toEqual(['The .env file missing.env is relative to a project\'s folder, and this session has no project.']);
  });
});

describe('files copied into a new worktree', () => {
  function repoWithLocalFiles() {
    const root = makeRepo();
    put(root, '.gitignore', '.env*\nlocal/\n');
    put(root, '.env', 'SECRET=1\n');
    put(root, '.env.local', 'LOCAL=1\n');
    put(root, 'local/db/creds.json', '{}');
    put(root, 'notes.txt', 'untracked, not ignored\n');
    const worktree = join(tempDir('wt'), 'w');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'feat/x', worktree], { cwd: root, stdio: 'ignore' });
    return { root, worktree };
  }

  it('copies the untracked files the patterns name, in their folders, and nothing tracked', async () => {
    const { root, worktree } = repoWithLocalFiles();
    const all: EnvByScope = { [GLOBAL_ENV]: { vars: '', files: [], copy: ['.env*'] }, p: { vars: '', files: [], copy: ['local/**', 'a.txt'] } };
    const result = await copyIntoWorktree(all, 'p', root, worktree);
    expect(result.problems).toEqual([]);
    expect(result.copied.sort()).toEqual(['.env', '.env.local', 'local/db/creds.json']);
    expect(readFileSync(join(worktree, 'local/db/creds.json'), 'utf8')).toBe('{}');
    expect(existsSync(join(worktree, 'notes.txt'))).toBe(false);
    expect(copiedNotice(result.copied.sort())).toBe('Copied 3 files from the project\'s folder into this worktree: .env, .env.local, local/db/creds.json.');
  });

  it('never writes over a file the worktree already has, and copies nothing with no patterns', async () => {
    const { root, worktree } = repoWithLocalFiles();
    put(worktree, '.env', 'MINE=1\n');
    const result = await copyIntoWorktree({ p: { vars: '', files: [], copy: ['.env'] } }, 'p', root, worktree);
    expect(result.copied).toEqual([]);
    expect(readFileSync(join(worktree, '.env'), 'utf8')).toBe('MINE=1\n');
    expect(await copyIntoWorktree({}, 'p', root, worktree)).toEqual({ copied: [], problems: [] });
    expect(copiedNotice([])).toBeNull();
  });
});

describe('a session in a project with environment settings', () => {
  async function world() {
    const workspace = new Workspace(memoryPersistence());
    const agents = new FakeAgents();
    const shellEnv = { SHELL: '/bin/sh', PATH: process.env.PATH, HOME: tempDir('home') };
    const runtime = new SessionRuntime(workspace, { claude: agents.adapter() }, tempDir('data'), { projectScripts: { run: (run) => runScript({ ...run, env: shellEnv }) } });
    const repo = makeRepo();
    put(repo, '.gitignore', '.env\n');
    put(repo, '.env', 'FROM_FILE=yes\n');
    const project = await runtime.registerProject(repo, 'cm');
    const sessionOf = async (id: string) => (await workspace.state()).sessions.find((s) => s.id === id)!;
    const notices = (id: string) => runtime.overlay(id)!.messages.filter((m) => m.notice).map((m) => m.text);
    return { workspace, agents, runtime, project, sessionOf, notices };
  }

  it('copies the files, then gives the variables to the setup script and to the agent', async () => {
    const { agents, runtime, project, sessionOf, notices } = await world();
    await runtime.projectEnv.set(GLOBAL_ENV, { vars: 'LOG=info', files: [], copy: [] });
    await runtime.projectEnv.set(project.id, { vars: 'PORT=4000', files: ['.env'], copy: ['.env'] });
    await runtime.projectScripts.scripts.set(project.id, { setup: 'echo "$PORT $FROM_FILE $LOG" > seen; test -f .env', archive: '' });
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Fix it' });
    await runtime.idle(session.id);
    const worktree = (await sessionOf(session.id)).worktreePath!;
    expect(readFileSync(join(worktree, 'seen'), 'utf8').trim()).toBe('4000 yes info');
    expect(agents.starts[0]!.options.env).toEqual({ LOG: 'info', FROM_FILE: 'yes', PORT: '4000' });
    expect(notices(session.id)).toContain('Copied 1 file from the project\'s folder into this worktree: .env.');
  });

  it('gives an agent no extra variables when nothing is set, and tells the session about a file it could not read', async () => {
    const { agents, runtime, project, notices } = await world();
    const plain = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Fix it' });
    await runtime.idle(plain.id);
    expect(agents.starts[0]!.options.env).toBeUndefined();
    await runtime.projectEnv.set(project.id, { vars: '', files: ['gone.env'], copy: [] });
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Fix it' });
    await runtime.idle(session.id);
    expect(notices(session.id)).toContain('The .env file gone.env could not be read: it does not exist.');
    expect(agents.starts).toHaveLength(2);
  });

  it('serves and stores the settings over HTTP, for a project or for all, and refuses bad ones with the reason', async () => {
    const { workspace, project } = await world();
    const prefs = new ProjectEnvPrefs();
    const route = (method: string, body: Record<string, unknown> = {}) => projectEnvRoute(['api', 'project-env'], method, async () => body, workspace, prefs);
    expect(await route('GET')).toEqual({ status: 200, body: { env: {} } });
    expect(await route('PUT', { scope: 'nope', vars: '', files: [], copy: [] })).toEqual({ status: 400, body: { error: 'No such project.' } });
    expect(await route('PUT', { scope: project.id, vars: 'KESTREL_X=1', files: [], copy: [] })).toMatchObject({ status: 400 });
    expect(await route('PUT', { scope: GLOBAL_ENV, vars: 'A=1', files: ['~/x.env'], copy: [] })).toEqual({ status: 200, body: { env: { '*': { vars: 'A=1', files: ['~/x.env'], copy: [] } } } });
    expect(await route('PUT', { scope: project.id, vars: '', files: [], copy: ['.env'] })).toMatchObject({ status: 200, body: { env: { [project.id]: { copy: ['.env'] } } } });
    expect(await projectEnvRoute(['api', 'other'], 'GET', async () => ({}), workspace, prefs)).toBeNull();
  });
});
