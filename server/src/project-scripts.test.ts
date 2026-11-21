// A project's setup and archive scripts (shared/project-scripts.ts, project-scripts/*,
// runtime/project-scripts.ts): the rules, the real runner on real shells, and a session's start
// and archive on a real repository.
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createKestrelServer } from './http.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { projectScriptsRoute } from './project-scripts/api.ts';
import { ProjectScriptsPrefs } from './project-scripts/prefs.ts';
import { runScript, scriptVars } from './project-scripts/run.ts';
import { SessionRuntime } from './runtime.ts';
import { MAX_SCRIPT_CHARS, sanitizeScriptsByProject, scriptFailure, scriptProblem, setupFailureText, tailOf, withScripts } from './shared/project-scripts.ts';
import { FakeAgents, until } from './test-agent.ts';
import { makeRepo } from './test-repo.ts';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import { Workspace } from './workspace.ts';

vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

const tempDir = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `kestrel-${name}-`)));
// A plain shell, so the developer's login files do not slow or change the run.
const ENV = { SHELL: '/bin/sh', PATH: process.env.PATH, HOME: tempDir('home'), KESTREL_TOKEN: 'secret' };

describe('the rules', () => {
  it('keeps only projects that have a script, and drops unreadable ones', () => {
    expect(sanitizeScriptsByProject({ a: { setup: 'pnpm install', archive: 7 }, b: { setup: '  ', archive: '' }, c: 'nope' })).toEqual({ a: { setup: 'pnpm install', archive: '' } });
    expect(sanitizeScriptsByProject(['x'])).toEqual({});
  });

  it('replaces a project’s scripts, and forgets a project left with none', () => {
    const one = withScripts({}, 'a', { setup: 'make', archive: '' });
    expect(one).toEqual({ a: { setup: 'make', archive: '' } });
    expect(withScripts(one, 'a', { setup: '', archive: '' })).toEqual({});
  });

  it('refuses a script that is not text or is too long, with the reason', () => {
    expect(scriptProblem('echo hi')).toBeNull();
    expect(scriptProblem(3)).toBe('A script is text.');
    expect(scriptProblem('x'.repeat(MAX_SCRIPT_CHARS + 1))).toMatch(/at most 8000 characters/);
  });

  it('says how a script ended in words, and what to do about a failed setup', () => {
    expect(scriptFailure('setup', { status: 'ok', tail: '' })).toBeNull();
    expect(scriptFailure('archive', { status: 'failed', code: 2, tail: '' })).toBe('The project\'s archive script failed (exit 2).');
    expect(scriptFailure('setup', { status: 'timed-out', tail: '' })).toBe('The project\'s setup script was still running after 15 minutes and was ended.');
    expect(setupFailureText({ status: 'failed', code: 1, tail: '' })).toBe('The project\'s setup script failed (exit 1). The agent was not started. Reply to run the script again, or change it on the project\'s Settings tab under Scripts.');
  });

  it('keeps the end of the output, from the start of a line', () => {
    expect(tailOf('one\ntwo\nthree\n', 9)).toBe('three');
    expect(tailOf('short\n')).toBe('short');
  });
});

describe('running a script', () => {
  const vars = scriptVars({ root: '/repo', worktree: '/wt', branch: 'feat/x', projectName: 'Bellbird', sessionId: 's1' });

  it('runs in the folder with its variables and without Kestrel’s own, and streams what it prints', async () => {
    const cwd = tempDir('cwd');
    const seen: string[] = [];
    const outcome = await runScript({ kind: 'setup', script: 'echo "$KESTREL_ROOT_PATH $KESTREL_BRANCH [$KESTREL_TOKEN]"; pwd; echo err >&2', cwd, vars, env: ENV, onOutput: (d) => seen.push(d) });
    expect(outcome.status).toBe('ok');
    expect(outcome.tail).toContain('/repo feat/x []');
    expect(outcome.tail).toContain(cwd);
    expect(seen.join('')).toContain('err');
  });

  it('reports the exit code and the end of the output when it fails', async () => {
    expect(await runScript({ kind: 'setup', script: 'echo broken; exit 3', cwd: tempDir('cwd'), vars, env: ENV })).toEqual({ status: 'failed', code: 3, tail: 'broken' });
  });

  it('ends the script and what it started when its time runs out or it is stopped', async () => {
    const cwd = tempDir('cwd');
    const late = await runScript({ kind: 'archive', script: 'sleep 30 & wait', cwd, vars, env: ENV, timeoutMs: 200 });
    expect(late.status).toBe('timed-out');
    const abort = new AbortController();
    const running = runScript({ kind: 'setup', script: 'echo started; sleep 30', cwd, vars, env: ENV, signal: abort.signal });
    setTimeout(() => abort.abort(), 200);
    expect((await running).status).toBe('stopped');
  });

  it('says why when it cannot be run at all', async () => {
    const outcome = await runScript({ kind: 'setup', script: 'true', cwd: join(tempDir('cwd'), 'missing'), vars, env: ENV });
    expect(outcome.status).toBe('not-run');
  });
});

describe('a session in a project with scripts', () => {
  async function world() {
    const workspace = new Workspace(memoryPersistence());
    const agents = new FakeAgents();
    const runtime = new SessionRuntime(workspace, { claude: agents.adapter() }, tempDir('data'), { projectScripts: { run: (run) => runScript({ ...run, env: ENV }) } });
    const project = await runtime.registerProject(makeRepo(), 'cm');
    const scripts = runtime.projectScripts.scripts;
    const sessionOf = async (id: string) => (await workspace.state()).sessions.find((s) => s.id === id)!;
    const steps = (id: string) => runtime.overlay(id)!.messages.flatMap((m) => m.activity ?? []);
    return { workspace, agents, runtime, project, scripts, sessionOf, steps };
  }

  it('runs the setup script in the new worktree before the agent starts, as a step and a command', async () => {
    const { agents, runtime, project, scripts, sessionOf, steps } = await world();
    await scripts.set(project.id, { setup: 'echo "$KESTREL_ROOT_PATH" > .setup-ran; echo installed', archive: '' });
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Fix it' });
    await runtime.idle(session.id);
    const worktree = (await sessionOf(session.id)).worktreePath!;
    expect(readFileSync(join(worktree, '.setup-ran'), 'utf8').trim()).toBe(project.folders[0]!.path);
    expect(agents.starts).toHaveLength(1);
    expect(steps(session.id)[0]).toMatchObject({ text: 'Run cm\'s setup script', status: 'done', detail: 'installed' });
    expect(runtime.commands.list(session.id)[0]).toMatchObject({ label: 'Setup script', status: 'completed' });
  });

  it('does not start the agent when setup fails, says why, and runs it again on a reply', async () => {
    const { agents, runtime, project, scripts, sessionOf, steps } = await world();
    await scripts.set(project.id, { setup: 'echo no lockfile; exit 1', archive: '' });
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Fix it' });
    await until(async () => (await sessionOf(session.id)).state === 'attention', 'the failure');
    expect(agents.starts).toHaveLength(0);
    expect((await sessionOf(session.id)).note).toMatch(/^Failed · The project's setup script failed \(exit 1\)/);
    expect(steps(session.id)[0]).toMatchObject({ status: 'failed', detail: 'The project\'s setup script failed (exit 1).\n\nno lockfile' });
    const worktree = (await sessionOf(session.id)).worktreePath!;

    await scripts.set(project.id, { setup: 'echo fixed', archive: '' });
    await runtime.reply(session.id, 'try again');
    await until(() => agents.starts.length === 1, 'the agent');
    await runtime.idle(session.id);
    expect((await sessionOf(session.id)).worktreePath).toBe(worktree); // the same worktree, not a second one
    expect(agents.starts[0]!.prompt).toBe('Fix it\n\ntry again');
    expect(steps(session.id).map((s) => s.status)).toEqual(['failed', 'done']);
  });

  it('stops the script with the session, and leaves it unstarted', async () => {
    const { agents, runtime, project, scripts, sessionOf } = await world();
    await scripts.set(project.id, { setup: 'echo started; sleep 30', archive: '' });
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Fix it' });
    await until(() => runtime.commands.list(session.id).some((c) => c.status === 'running'), 'the script');
    await runtime.stop(session.id);
    await until(async () => (await sessionOf(session.id)).state !== 'running', 'the stop');
    expect(agents.starts).toHaveLength(0);
    expect(runtime.commands.list(session.id)[0]!.status).not.toBe('running');
  });

  it('runs nothing in a project with no script, or in a plain folder', async () => {
    const { agents, runtime, project, scripts, steps } = await world();
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Fix it' });
    await runtime.idle(session.id);
    expect(steps(session.id)).toEqual([]);
    const plain = await runtime.registerProject(tempDir('plain'), 'notes');
    await scripts.set(plain.id, { setup: 'touch ran', archive: '' });
    const inPlain = await runtime.start({ agent: 'claude', projectId: plain.id, prompt: 'Tidy' });
    await runtime.idle(inPlain.id);
    expect(existsSync(join(plain.folders[0]!.path, 'ran'))).toBe(false);
    expect(agents.starts).toHaveLength(2);
  });

  it('runs the archive script in the worktree before archiving, and reports a failure', async () => {
    const { runtime, project, scripts, sessionOf } = await world();
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Fix it' });
    await runtime.idle(session.id);
    expect(await runtime.runArchiveScript(session.id)).toBeNull(); // no script
    const worktree = (await sessionOf(session.id)).worktreePath!;
    await scripts.set(project.id, { setup: '', archive: 'echo "$KESTREL_BRANCH" > .archived' });
    expect((await runtime.runArchiveScript(session.id))!.status).toBe('ok');
    expect(readFileSync(join(worktree, '.archived'), 'utf8').trim()).toBe((await sessionOf(session.id)).branch);
    await scripts.set(project.id, { setup: '', archive: 'echo port busy; exit 4' });
    expect(await runtime.runArchiveScript(session.id)).toEqual({ status: 'failed', code: 4, tail: 'port busy' });
  });

  it('serves and stores a project’s scripts over HTTP, and refuses an unknown project or a bad script', async () => {
    const { workspace, project } = await world();
    const prefs = new ProjectScriptsPrefs();
    const route = (method: string, body: Record<string, unknown> = {}) => projectScriptsRoute(['api', 'project-scripts'], method, async () => body, workspace, prefs);
    expect(await route('GET')).toEqual({ status: 200, body: { scripts: {} } });
    expect(await route('PUT', { projectId: 'nope', setup: 'x', archive: '' })).toEqual({ status: 400, body: { error: 'No such project.' } });
    expect(await route('PUT', { projectId: project.id, setup: 'x' })).toEqual({ status: 400, body: { error: 'A script is text.' } });
    expect(await route('PUT', { projectId: project.id, setup: 'pnpm install', archive: '  ' })).toEqual({ status: 200, body: { scripts: { [project.id]: { setup: 'pnpm install', archive: '' } } } });
    expect(await projectScriptsRoute(['api', 'other'], 'GET', async () => ({}), workspace, prefs)).toBeNull();
  });

  it('stops an archive whose script fails with the reason and its output, and archives without it when asked', async () => {
    const { workspace, runtime, project, scripts } = await world();
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Fix it' });
    await runtime.idle(session.id);
    await scripts.set(project.id, { setup: '', archive: 'echo port busy; exit 4' });
    const policy = { token: 'test-token', allowedOrigins: ['http://localhost:5173'], port: 0 };
    const app = createKestrelServer(workspace, policy, runtime);
    await app.listen();
    policy.port = (app.server.address() as AddressInfo).port;
    const archive = (extra: Record<string, unknown> = {}) => fetch(`http://127.0.0.1:${policy.port}/api/archive`, { method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'session', id: session.id, archived: true, ...extra }) });
    try {
      const refused = await archive();
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ error: 'The project\'s archive script failed (exit 4). The session was not archived.', archiveScript: { output: 'port busy' } });
      expect((await workspace.state()).sessions.some((s) => s.id === session.id)).toBe(true);
      expect((await archive({ skipScript: true })).status).toBe(204);
      expect((await workspace.state()).archived.sessions.some((s) => s.id === session.id)).toBe(true);
    } finally {
      await app.close();
    }
  });
});
