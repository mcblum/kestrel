import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import type { TitleProvider } from './agents/title-providers.ts';
import type { AgentAdapter, AgentHandle } from './agents/types.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { SessionRuntime } from './runtime.ts';
import { TITLE_WAIT_MS, Titler } from './runtime/titling.ts';
import { makeRepo } from './test-repo.ts';
import { titleFrom } from './title.ts';
import { Workspace } from './workspace.ts';

// Builds real git repositories: room under a loaded machine (test-timeouts.ts).
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

const LONG_PROMPT = 'Please look into why the upload page hangs after a while\nIt started after the last deploy.';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

const gitOut = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd }).toString().trim();

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

/** An agent whose turns end at once. */
function agent() {
  const started: string[] = [];
  const prompts: string[] = [];
  const handle: AgentHandle = { agentSessionId: () => 'a', busy: () => false, send: () => undefined, answer: () => undefined, stop: async () => undefined };
  const adapter: AgentAdapter = {
    agent: 'claude',
    models: async () => ({ models: [], fromSdk: false }),
    start: (options, prompt, emit) => {
      started.push(options.directory);
      prompts.push(prompt);
      emit({ type: 'started', agentSessionId: 'a', model: 'fake', kestrelTools: 'connected' });
      emit({ type: 'done', reason: 'complete' });
      return handle;
    },
    resume: () => handle,
  };
  return { adapter, started, prompts };
}

/** A title provider whose answer is a promise the test settles (`reply`), and a wait the test ends (`cap`). */
function setup() {
  const workspace = new Workspace(memoryPersistence());
  const fake = agent();
  const asked: string[] = [];
  const waits: number[] = [];
  const control = { reply: deferred<string | null>(), cap: deferred<void>() };
  const provider: TitleProvider = { name: 'test', agent: 'claude', title: (prompt) => (asked.push(prompt), control.reply.promise) };
  const titleWait = (ms: number) => (waits.push(ms), control.cap.promise);
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-title-')));
  const runtime = new SessionRuntime(workspace, { claude: fake.adapter }, data, { titleProviders: [provider], titleWait });
  const row = async (id: string) => (await workspace.state()).sessions.find((s) => s.id === id)!;
  return { workspace, runtime, fake, asked, waits, control, row };
}

describe('generated session titles without a worktree', () => {
  it('start keeps the first line and starts the agent at once, then takes the generated title', async () => {
    const { runtime, fake, asked, waits, control, row } = setup();
    const session = await runtime.start({ agent: 'claude', projectId: null, prompt: LONG_PROMPT });
    expect(session.title).toBe(titleFrom(LONG_PROMPT));
    expect(fake.started).toHaveLength(1); // no wait for a session without a branch
    expect(waits).toEqual([]);
    expect(asked).toEqual([LONG_PROMPT]);
    control.reply.resolve('"Debug upload page hang."');
    await runtime.titler.settled();
    expect((await row(session.id)).title).toBe('Debug upload page hang');
  });

  it('never overwrites a rename the user made first', async () => {
    const { runtime, workspace, control, row } = setup();
    const session = await runtime.start({ agent: 'claude', projectId: null, prompt: LONG_PROMPT });
    await workspace.renameSession(session.id, 'Mine');
    control.reply.resolve('Debug upload page hang');
    await runtime.titler.settled();
    expect((await row(session.id)).title).toBe('Mine');
  });

  it('keeps the provisional title when generation fails', async () => {
    const { runtime, control, row } = setup();
    const session = await runtime.start({ agent: 'claude', projectId: null, prompt: LONG_PROMPT });
    control.reply.reject(new Error('not signed in'));
    await runtime.titler.settled();
    expect((await row(session.id)).title).toBe(titleFrom(LONG_PROMPT));
  });

  it('does not ask, or wait, for a short one-line prompt, even in a git project', async () => {
    const { runtime, asked, waits, fake } = setup();
    const project = await runtime.registerProject(makeRepo());
    await runtime.start({ agent: 'claude', projectId: null, prompt: 'Fix the build' });
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Fix the build' });
    await runtime.idle(session.id);
    expect(asked).toEqual([]);
    expect(waits).toEqual([]);
    expect(fake.started).toHaveLength(2);
  });
});

describe('the branch of a new session in a git project', () => {
  it('is named from the generated title when it comes within the wait; the row shows at once, starting', async () => {
    const { runtime, fake, waits, control, row } = setup();
    const project = await runtime.registerProject(makeRepo());
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: LONG_PROMPT });
    expect(session).toMatchObject({ title: titleFrom(LONG_PROMPT), branch: null, worktreePath: null, note: 'Starting…' });
    expect(fake.started).toEqual([]);
    expect(await runtime.reply(session.id, 'and keep the old API')).toBe('queued'); // waits for the first turn
    control.reply.resolve('Debug upload page hang');
    await runtime.idle(session.id);
    const after = await row(session.id);
    expect(after.title).toBe('Debug upload page hang');
    expect(after.branch).toMatch(/^kestrel\/debug-upload-page-hang-/);
    expect(fake.started).toEqual([after.worktreePath]);
    expect(waits).toEqual([TITLE_WAIT_MS]);
  });

  it('is named from the provisional title when the wait ends first, and renamed to the late title', async () => {
    const { runtime, control, row } = setup();
    const project = await runtime.registerProject(makeRepo());
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: LONG_PROMPT });
    control.cap.resolve();
    await runtime.idle(session.id);
    const first = await row(session.id);
    expect(first.branch).toMatch(/^kestrel\/please-look-into-why-the-/);
    const base = gitOut(first.worktreePath!, 'config', '--get', `branch.${first.branch}.kestrelbase`);
    control.reply.resolve('Debug upload page hang');
    await runtime.titler.settled();
    const after = await row(session.id);
    expect(after.title).toBe('Debug upload page hang');
    expect(after.branch).toMatch(/^kestrel\/debug-upload-page-hang-/);
    expect(after.worktreePath).toBe(first.worktreePath);
    expect(gitOut(after.worktreePath!, 'branch', '--show-current')).toBe(after.branch);
    expect(gitOut(after.worktreePath!, 'config', '--get', `branch.${after.branch}.kestrelbase`)).toBe(base); // its base goes with it
    expect(gitOut(project.folders[0]!.path, 'branch', '--list', first.branch!)).toBe('');
  });

  it('keeps the provisional name when the late title comes after the branch was pushed', async () => {
    const { runtime, control, row } = setup();
    const repo = makeRepo();
    const remote = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-remote-')));
    execFileSync('git', ['init', '-q', '--bare', remote]);
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: repo });
    const project = await runtime.registerProject(repo);
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: LONG_PROMPT });
    control.cap.resolve();
    await runtime.idle(session.id);
    const first = await row(session.id);
    execFileSync('git', ['push', '-q', 'origin', first.branch!], { cwd: first.worktreePath! }); // no upstream set: only the remote ref tells
    control.reply.resolve('Debug upload page hang');
    await runtime.titler.settled();
    expect(await row(session.id)).toMatchObject({ title: 'Debug upload page hang', branch: first.branch });
    expect(gitOut(first.worktreePath!, 'branch', '--show-current')).toBe(first.branch);
  });

  it('keeps the provisional name when the worktree has switched to another branch meanwhile', async () => {
    const { runtime, control, row } = setup();
    const project = await runtime.registerProject(makeRepo());
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: LONG_PROMPT });
    control.cap.resolve();
    await runtime.idle(session.id);
    const first = await row(session.id);
    execFileSync('git', ['switch', '-q', '-c', 'feat/agents-own'], { cwd: first.worktreePath! });
    control.reply.resolve('Debug upload page hang');
    await runtime.titler.settled();
    expect((await row(session.id)).branch).toBe(first.branch);
    expect(gitOut(project.folders[0]!.path, 'branch', '--list', first.branch!)).toContain(first.branch!);
  });

  it('is named from the user’s title when they renamed the session during the wait', async () => {
    const { runtime, workspace, control, row } = setup();
    const project = await runtime.registerProject(makeRepo());
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: LONG_PROMPT });
    await workspace.renameSession(session.id, 'Upload timeout');
    control.reply.resolve('Debug upload page hang');
    await runtime.idle(session.id);
    expect(await row(session.id)).toMatchObject({ title: 'Upload timeout', branch: expect.stringMatching(/^kestrel\/upload-timeout-/) });
  });

  it('leaves the session failed, with the reason, when the worktree cannot be made', async () => {
    const { runtime, fake, control, row } = setup();
    const empty = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-empty-')));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: empty });
    const project = await runtime.registerProject(empty);
    expect(project.folders[0]!.isGit).toBe(true);
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: LONG_PROMPT });
    control.reply.resolve(null);
    await runtime.idle(session.id);
    expect(await row(session.id)).toMatchObject({ state: 'attention', note: expect.stringMatching(/^Failed · The agent could not be started: This repository has no commits yet/), branch: null });
    expect(fake.started).toEqual([]);
  });

  it('for a child, waits for the title before making its worktree, and not for one given an explicit title', async () => {
    const { runtime, workspace, asked, control, row } = setup();
    const project = await runtime.registerProject(makeRepo());
    const fallback = await workspace.addSession({ title: titleFrom(LONG_PROMPT), agent: 'claude', startedIn: project.id, state: 'running' });
    const launching = runtime.launchChild(fallback, project, project.folders[0]!, LONG_PROMPT, 'spawn', '', 'ask');
    control.reply.resolve('Debug upload page hang');
    expect(await launching).toEqual({ ok: true });
    expect(await row(fallback.id)).toMatchObject({ title: 'Debug upload page hang', branch: expect.stringMatching(/^kestrel\/debug-upload-page-hang-/) });

    const named = await workspace.addSession({ title: 'Named by caller', agent: 'claude', startedIn: project.id, state: 'running' });
    expect(await runtime.launchChild(named, project, project.folders[0]!, LONG_PROMPT, 'spawn', '', 'ask')).toEqual({ ok: true });
    expect(asked).toHaveLength(1);
    expect((await row(named.id)).branch).toMatch(/^kestrel\/named-by-caller-/);
  });
});

describe('stopping a session while it starts', () => {
  it('abandons the start during the title wait: no worktree, no agent, stopped; a reply starts it with both messages', async () => {
    const { runtime, fake, waits, row } = setup();
    const project = await runtime.registerProject(makeRepo());
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: LONG_PROMPT });
    await runtime.stop(session.id); // the title never comes and the wait never ends: Stop does not wait for them
    expect(waits).toEqual([TITLE_WAIT_MS]);
    expect(fake.started).toEqual([]);
    expect(await row(session.id)).toMatchObject({ state: 'done', note: 'Stopped', worktreePath: null, branch: null });

    expect(await runtime.reply(session.id, 'and keep the old API')).toBe('sent');
    expect((await row(session.id)).note).toBe('Starting…');
    await runtime.idle(session.id);
    const after = await row(session.id);
    expect(after.branch).toMatch(/^kestrel\/please-look-into-why-the-/);
    expect(fake.started).toEqual([after.worktreePath]);
    expect(fake.prompts).toEqual([`${LONG_PROMPT}\n\nand keep the old API`]);
  });

  it('keeps a worktree already made on the row, and a reply starts the agent in it', async () => {
    const { runtime, workspace, fake, control, row } = setup();
    const project = await runtime.registerProject(makeRepo());
    const attach = workspace.attachWorktree.bind(workspace);
    let stopping: Promise<void> | null = null;
    workspace.attachWorktree = async (id, worktree) => {
      await attach(id, worktree);
      stopping = runtime.stop(id); // Stop lands just as the worktree is made
    };
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: LONG_PROMPT });
    control.reply.resolve('Debug upload page hang');
    await runtime.idle(session.id);
    await stopping;
    const stopped = await row(session.id);
    expect(stopped).toMatchObject({ state: 'done', note: 'Stopped', branch: expect.stringMatching(/^kestrel\/debug-upload-page-hang-/) });
    expect(fake.started).toEqual([]);

    workspace.attachWorktree = attach;
    await runtime.reply(session.id, 'go on');
    await runtime.idle(session.id);
    expect(fake.started).toEqual([stopped.worktreePath]);
    expect((await row(session.id)).branch).toBe(stopped.branch);
  });

  it('still refuses a session that is neither starting nor in a turn', async () => {
    const { runtime } = setup();
    const session = await runtime.start({ agent: 'claude', projectId: null, prompt: 'Fix the build' });
    await runtime.idle(session.id);
    await expect(runtime.stop(session.id)).rejects.toThrow(/not running/);
  });
});

describe('title providers', () => {
  const provider = (name: string, agentName: 'claude' | 'codex', answer: () => Promise<string | null>, asked: string[]): TitleProvider => ({
    name,
    agent: agentName,
    title: () => (asked.push(name), answer()),
  });

  async function titled(providers: (asked: string[]) => TitleProvider[], agentName: 'claude' | 'codex') {
    const workspace = new Workspace(memoryPersistence());
    const session = await workspace.addSession({ title: titleFrom(LONG_PROMPT), agent: agentName, startedIn: null, state: 'running' });
    const asked: string[] = [];
    const logs: string[] = [];
    const titler = new Titler(workspace, providers(asked), () => new Promise(() => undefined), (line) => logs.push(line));
    titler.begin({ sessionId: session.id, provisional: session.title, prompt: LONG_PROMPT, agent: agentName });
    await titler.settled();
    const title = (await workspace.state()).sessions[0]!.title;
    return { asked, logs, title };
  }

  it('asks the one for the session’s agent first, and falls through to the next on null or an error', async () => {
    const both = (asked: string[]) => [
      provider('claude', 'claude', async () => { throw new Error('not signed in'); }, asked),
      provider('codex', 'codex', async () => 'Debug upload page hang', asked),
    ];
    expect(await titled(both, 'claude')).toMatchObject({ asked: ['claude', 'codex'], title: 'Debug upload page hang', logs: [] });
    expect(await titled(both, 'codex')).toMatchObject({ asked: ['codex'], title: 'Debug upload page hang' });
  });

  it('keeps the provisional title and logs once when every provider fails', async () => {
    const none = (asked: string[]) => [provider('claude', 'claude', async () => null, asked), provider('codex', 'codex', async () => { throw new Error('codex exited with 1'); }, asked)];
    const out = await titled(none, 'claude');
    expect(out.title).toBe(titleFrom(LONG_PROMPT));
    expect(out.logs).toHaveLength(1);
    expect(out.logs[0]).toMatch(/claude: no reply; codex: codex exited with 1/);
  });
});
