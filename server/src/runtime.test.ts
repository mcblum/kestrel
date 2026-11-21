import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { until } from './test-agent.ts';
import type { LivePatch } from './model.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import type { AgentAdapter, AgentEvent, AgentHandle, StartOptions } from './agents/types.ts';
import { makeRepo } from './test-repo.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { SessionRuntime } from './runtime.ts';
import { Workspace } from './workspace.ts';

// Builds real git repositories: room under a loaded machine (test-timeouts.ts).
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

/** A scripted agent: no model, no timing. `script` decides what each turn does. */
class Script {
  starts: { options: StartOptions; prompt: string }[] = [];
  resumes: { id: string; options: StartOptions }[] = [];
  emitters: ((e: AgentEvent) => void)[] = [];
  turn: (options: StartOptions, emit: (e: AgentEvent) => void) => void = (o, emit) => {
    writeFileSync(join(o.directory, 'hello.txt'), 'hi\n');
    emit({ type: 'files-changed', paths: [] });
    emit({ type: 'done', reason: 'complete' });
  };
  adapter(): AgentAdapter {
    const handle = (options: StartOptions, emit: (e: AgentEvent) => void, id: string): AgentHandle => {
      let busy = false;
      return {
        agentSessionId: () => id,
        busy: () => busy,
        send: () => {
          busy = true;
          this.turn(options, (e) => {
            if (e.type === 'done' || e.type === 'failed') busy = false;
            emit(e);
          });
        },
        answer: () => undefined,
        stop: async () => undefined,
      };
    };
    return {
      agent: 'claude',
      models: async () => ({ models: [{ id: '', label: 'Default' }], fromSdk: false }),
      start: (options, prompt, emit) => {
        this.starts.push({ options, prompt });
        this.emitters.push(emit);
        emit({ type: 'started', agentSessionId: 'agent-1', model: 'fake', kestrelTools: 'connected' });
        const h = handle(options, emit, 'agent-1');
        h.send(prompt);
        return h;
      },
      resume: (id, options, emit) => {
        this.resumes.push({ id, options });
        return handle(options, emit, id);
      },
    };
  }
}

async function setup(now?: () => number, clock?: () => number) {
  const db = memoryPersistence();
  const workspace = new Workspace(db, clock);
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-rt-')));
  const script = new Script();
  const runtime = new SessionRuntime(workspace, { claude: script.adapter() }, data, now ? { now } : {});
  return { db, workspace, data, script, runtime };
}

describe('latest activity', () => {
  it('moves when a message is sent and when the turn ends, not with the status line', async () => {
    let tick = 1000;
    const { db, runtime, script } = await setup(undefined, () => tick++);
    script.turn = (_o, emit) => emit({ type: 'done', reason: 'complete' });
    const older = await runtime.start({ agent: 'claude', projectId: null, prompt: 'first' });
    await runtime.idle(older.id);
    const newer = await runtime.start({ agent: 'claude', projectId: null, prompt: 'second' });
    await runtime.idle(newer.id);
    const at = async (id: string) => (await db.getSession(id))!.lastActivityAt!;
    expect(await at(newer.id)).toBeGreaterThan(await at(older.id));

    let finish: (() => void) | null = null;
    script.turn = (_o, emit) => void (finish = () => emit({ type: 'done', reason: 'complete' }));
    await runtime.reply(older.id, 'again');
    const started = await at(older.id);
    expect(started).toBeGreaterThan(await at(newer.id));
    finish!();
    await runtime.idle(older.id);
    expect(await at(older.id)).toBeGreaterThan(started);
  });
});

describe('starting a session in a git project', () => {
  it('runs in a new worktree and files the session under the project once it changes something', async () => {
    const { workspace, runtime, script, data } = await setup();
    const repo = makeRepo();
    const project = await runtime.registerProject(repo);
    expect(project.folders[0]!.isGit).toBe(true);
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Create hello.txt\nplease' });
    await runtime.idle(session.id);

    const start = script.starts[0]!;
    expect(start.options.directory.startsWith(join(data, 'worktrees'))).toBe(true);
    expect(start.options.permission).toBe('ask');
    expect(start.options.instruction).toContain('mcp__kestrel__list_projects');
    expect(start.options.instruction).toContain(repo);
    expect(existsSync(join(repo, 'hello.txt'))).toBe(false); // the main checkout is untouched

    const after = (await workspace.state()).sessions.find((s) => s.id === session.id)!;
    expect(after).toMatchObject({ title: 'Create hello.txt', state: 'done', landedIn: project.id, filing: { status: 'landed', projectId: project.id } });
    expect(after.branch).toMatch(/^kestrel\/create-hello-txt-/);
    const detail = (await workspace.detail(session.id))!;
    expect(detail.files.map((f) => f.path)).toEqual(['hello.txt']);
    expect(detail.kestrelTools).toBe('connected');
    expect(detail.agentSessionId).toBe('agent-1');
    expect(detail.messages[0]).toMatchObject({ author: 'you', text: 'Create hello.txt\nplease' });
  });

  it('stays filed under where it started while nothing has changed', async () => {
    const { workspace, runtime, script } = await setup();
    script.turn = (_o, emit) => emit({ type: 'done', reason: 'complete' });
    const project = await runtime.registerProject(makeRepo());
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Just look' });
    await runtime.idle(session.id);
    const after = (await workspace.state()).sessions.find((s) => s.id === session.id)!;
    expect(after.landedIn).toBeNull();
    expect(after.filing.status).toBe('started');
  });

  it('shows a failed run as needing attention with the reason', async () => {
    const { workspace, runtime, script } = await setup();
    script.turn = (_o, emit) => emit({ type: 'failed', reason: 'Claude is not signed in', kind: 'auth' });
    const project = await runtime.registerProject(makeRepo());
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'x' });
    await runtime.idle(session.id);
    expect((await workspace.state()).sessions.find((s) => s.id === session.id)).toMatchObject({ state: 'attention', note: 'Claude is not signed in' });
    expect((await workspace.detail(session.id))!.messages.at(-1)).toMatchObject({ notice: 'error' });
  });

  it('refuses an agent that is not connected, and an unknown project, with reasons', async () => {
    const { runtime } = await setup();
    await expect(runtime.start({ agent: 'codex', projectId: null, prompt: 'x' })).rejects.toThrow(/Codex is not available in Kestrel/);
    await expect(runtime.start({ agent: 'claude', projectId: 'nope', prompt: 'x' })).rejects.toThrow(/No such project/);
  });
});

describe('robustness', () => {
  it('finishes a turn with 100 file changes without waiting on each one', async () => {
    const { workspace, runtime, script } = await setup();
    script.turn = (o, emit) => {
      for (let i = 0; i < 100; i++) emit({ type: 'files-changed', paths: [] });
      writeFileSync(join(o.directory, 'many.txt'), 'x');
      emit({ type: 'done', reason: 'complete' });
    };
    const project = await runtime.registerProject(makeRepo());
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'go' });
    await runtime.idle(session.id);
    expect((await workspace.state()).sessions.find((x) => x.id === session.id)).toMatchObject({ state: 'done', landedIn: project.id });
    expect((await workspace.detail(session.id))!.files.map((f) => f.path)).toEqual(['many.txt']);
  });

  it('marks the session failed, with the reason, when the agent cannot be started', async () => {
    const { workspace, runtime, script } = await setup();
    const adapter = script.adapter();
    const broken = new SessionRuntime(workspace, { claude: { ...adapter, start: () => { throw new Error('no binary'); } } }, (await setup()).data);
    const project = await broken.registerProject(makeRepo());
    // In a git project the agent is started after the session is returned: the failure shows on the row.
    const session = await broken.start({ agent: 'claude', projectId: project.id, prompt: 'x' });
    await broken.idle(session.id);
    const stored = (await workspace.state()).sessions[0]!;
    expect(stored.state).toBe('attention');
    expect(stored.note).toMatch(/Failed · The agent could not be started: no binary/);
    expect(runtime).toBeDefined();
  });

  it('says the agent is not signed in when that is why it could not be started', async () => {
    const { workspace, script, data } = await setup();
    const notSignedIn = Object.assign(new Error('Codex is not signed in. Run `codex login`.'), { kind: 'auth' });
    const broken = new SessionRuntime(workspace, { claude: { ...script.adapter(), start: () => { throw notSignedIn; } } }, data);
    const project = await broken.registerProject(makeRepo());
    const session = await broken.start({ agent: 'claude', projectId: project.id, prompt: 'x' });
    await broken.idle(session.id);
    expect((await workspace.state()).sessions.find((s) => s.id === session.id)).toMatchObject({ state: 'attention', note: 'Claude is not signed in' });
    expect((await workspace.detail(session.id))!.messages.at(-1)!.text).toMatch(/codex login/);
  });
});

describe('permission level, model and project removal', () => {
  it('starts at the chosen level and model; a session without a project keeps the level it was given', async () => {
    const { runtime, script } = await setup();
    const project = await runtime.registerProject(makeRepo());
    await runtime.idle((await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'a', permission: 'edits', model: 'haiku' })).id);
    expect(script.starts[0]!.options).toMatchObject({ permission: 'edits', model: 'haiku' });
    await runtime.start({ agent: 'claude', projectId: null, prompt: 'b', permission: 'edits' });
    expect(script.starts[1]!.options.permission).toBe('edits');
    expect(script.starts[1]!.options.instruction).toMatch(/scratch folder/);
  });

  it('applies a changed model and level from the next message, through a resumed handle', async () => {
    const { workspace, runtime, script } = await setup();
    const project = await runtime.registerProject(makeRepo());
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'a' });
    await runtime.idle(session.id);
    await runtime.reply(session.id, 'again', { model: 'opus', permission: 'readonly' });
    await runtime.idle(session.id);
    expect(script.resumes).toHaveLength(1);
    expect(script.resumes[0]!.options).toMatchObject({ model: 'opus', permission: 'readonly' });
    expect((await workspace.detail(session.id))!.settings).toEqual({ model: 'opus', permission: 'readonly' });
    await runtime.reply(session.id, 'same settings'); // no change: the handle is kept
    expect(script.resumes).toHaveLength(1);
  });

  it('removes a project only when no session uses it', async () => {
    const { workspace, runtime } = await setup();
    const project = await runtime.registerProject(makeRepo());
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'a' });
    await runtime.idle(session.id);
    await expect(workspace.removeProject(project.id)).rejects.toThrow(/still has 1 session/);
    const other = await runtime.registerProject(makeRepo());
    await workspace.removeProject(other.id);
    expect((await workspace.state()).projects.map((p) => p.id)).toEqual([project.id]);
    await expect(workspace.removeProject(other.id)).rejects.toThrow(/No such project/);
  });

  it('keeps UI state in the store', async () => {
    const { workspace } = await setup();
    expect(await workspace.getUiState()).toBeNull();
    await workspace.setUiState('{"a":1}');
    expect(await workspace.getUiState()).toBe('{"a":1}');
  });
});

describe('plain folders and no project', () => {
  it('edits the folder itself, one session at a time', async () => {
    const { runtime, script } = await setup();
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-plain-')));
    const project = await runtime.registerProject(folder);
    expect(project.folders[0]!.isGit).toBe(false);
    script.turn = () => undefined; // the first session stays running
    const first = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'one' });
    expect(script.starts[0]!.options.directory).toBe(folder);
    await expect(runtime.start({ agent: 'claude', projectId: project.id, prompt: 'two' })).rejects.toThrow(/one editing session at a time/);
    expect(first.worktreePath).toBeNull();
  });

  it('runs without a project in a scratch folder with the registered projects readable', async () => {
    const { runtime, script, data } = await setup();
    const project = await runtime.registerProject(makeRepo());
    const session = await runtime.start({ agent: 'claude', projectId: null, prompt: 'look around' });
    const o = script.starts[0]!.options;
    expect(o).toMatchObject({ permission: 'ask', directory: join(data, 'scratch'), readableDirectories: [project.folders[0]!.path, runtime.attachments.sessionDir(session.id)] });
  });

  it('registers a git repository only by its root, and refuses duplicates and missing folders', async () => {
    const { runtime } = await setup();
    const repo = makeRepo();
    mkdirSync(join(repo, 'sub'));
    await expect(runtime.registerProject(join(repo, 'sub'))).rejects.toThrow(/Choose its root/);
    await runtime.registerProject(repo);
    await expect(runtime.registerProject(repo)).rejects.toThrow(/already registered/);
    await expect(runtime.registerProject('/no/such/folder')).rejects.toThrow(/does not exist|not a directory/);
  });
});

describe('choosing a folder in the picker', () => {
  it('returns the project already registered at that path instead of refusing', async () => {
    const { runtime } = await setup();
    const repo = makeRepo();
    const first = await runtime.registerProject(repo);
    const again = await runtime.ensureProject(repo);
    expect(again).toEqual({ project: first, created: false });
    expect((await runtime.ensureProject(`${repo}/`)).project.id).toBe(first.id);
  });

  it('registers a new folder and says so', async () => {
    const { runtime } = await setup();
    const picked = await runtime.ensureProject(makeRepo());
    expect(picked.created).toBe(true);
    expect(picked.project.name).toBeTruthy();
  });

  it('still refuses a folder that does not exist', async () => {
    const { runtime } = await setup();
    await expect(runtime.ensureProject('/no/such/folder')).rejects.toThrow(/not a directory/);
  });
});

describe('slash commands', () => {
  it('keeps the list the agent gives, sends it to whoever watches, and has it again after a restart', async () => {
    const { db, runtime, script, data } = await setup();
    const commands = [{ name: 'compact', description: 'Compact the conversation' }, { name: 'ship', description: 'Ship it', argumentHint: '<pr>' }];
    script.turn = (_o, emit) => {
      emit({ type: 'slash-commands', commands });
      emit({ type: 'done', reason: 'complete' });
    };
    const patches: LivePatch[] = [];
    runtime.onLive((_id, patch) => patches.push(patch));
    const session = await runtime.start({ agent: 'claude', projectId: null, prompt: 'go' });
    await runtime.idle(session.id);
    expect((await runtime.snapshot(session.id))!.slashCommands).toEqual(commands);
    expect(patches.filter((p) => p.slashCommands).map((p) => p.slashCommands)).toEqual([commands]);
    await runtime.shutdown();

    const runtime2 = new SessionRuntime(new Workspace(db), { claude: new Script().adapter() }, data);
    await runtime2.recoverAfterRestart();
    expect((await runtime2.snapshot(session.id))!.slashCommands).toEqual(commands);
  });
});

describe('slash commands before a session exists', () => {
  it('are asked of the agent for the chosen project, once, and nothing is made for it', async () => {
    const { runtime, script, workspace, data } = await setup();
    const project = await runtime.registerProject(makeRepo(), 'repo');
    const listed = [{ name: 'compact', description: 'Compact the conversation' }];
    const asked: string[] = [];
    const adapter = script.adapter();
    const withList = new SessionRuntime(workspace, { claude: { ...adapter, slashCommands: async (options) => (asked.push(options.directory), listed) } }, data);
    expect(await withList.draftSlashCommands('claude', project.id, null)).toEqual(listed);
    expect(await withList.draftSlashCommands('claude', project.id, null)).toEqual(listed);
    expect(asked.map((dir) => realpathSync(dir))).toEqual([realpathSync(project.folders[0]!.path)]);
    // With no project it is asked in the scratch folder, as such a session would run.
    expect(await withList.draftSlashCommands('claude', null, null)).toEqual(listed);
    expect(asked).toHaveLength(2);
    expect((await workspace.state()).sessions).toHaveLength(0);
    expect(existsSync(join(data, 'attachments', 'draft'))).toBe(false);
  });

  it('are none for an agent that lists none, and asked again after it could not say', async () => {
    const { runtime, script, workspace, data } = await setup();
    expect(await runtime.draftSlashCommands('claude', null, null)).toEqual([]);
    let asked = 0;
    const failing = new SessionRuntime(workspace, { claude: { ...script.adapter(), slashCommands: async () => (asked++, null) } }, data);
    expect(await failing.draftSlashCommands('claude', null, null)).toEqual([]);
    expect(await failing.draftSlashCommands('claude', null, null)).toEqual([]);
    expect(asked).toBe(2);
    await expect(failing.draftSlashCommands('claude', 'nope', null)).rejects.toThrow(/No such project/);
  });
});

describe('slash commands for a session that has no list', () => {
  it('are asked of the agent when the session is opened, without a turn, once', async () => {
    const { runtime, script } = await setup();
    const session = await runtime.start({ agent: 'claude', projectId: null, prompt: 'go' });
    await runtime.idle(session.id);
    expect((await runtime.snapshot(session.id))!.slashCommands).toEqual([]);

    // The same store, a server whose agent can say what it offers without running.
    let asked = 0;
    const listed = [{ name: 'compact', description: 'Compact the conversation' }];
    const { db, data } = { db: (runtime as unknown as { workspace: { db: unknown } }).workspace.db, data: (runtime as unknown as { dataDir: string }).dataDir };
    await runtime.shutdown();
    const adapter = new Script().adapter();
    const runtime2 = new SessionRuntime(new Workspace(db as never), { claude: { ...adapter, slashCommands: async () => (asked++, listed) } }, data);
    await runtime2.recoverAfterRestart();
    const patches: LivePatch[] = [];
    runtime2.onLive((_id, patch) => patches.push(patch));
    await runtime2.snapshot(session.id);
    await runtime2.snapshot(session.id);
    await until(() => patches.some((p) => p.slashCommands), 'the list');
    expect((await runtime2.snapshot(session.id))!.slashCommands).toEqual(listed);
    expect(asked).toBe(1);
  });
});

describe('commands across a restart', () => {
  it('keeps what the agent ran and what it printed, shows a command that was running as stopped, and retries one by telling the agent', async () => {
    const { db, runtime, script, data } = await setup();
    script.turn = (_o, emit) => {
      emit({ type: 'tool', id: 't1', status: 'started', name: 'Bash', text: 'Run terraform plan', command: 'terraform plan' } as never);
      emit({ type: 'tool', id: 't1', status: 'failed', name: 'Bash', text: 'Run terraform plan', detail: 'Error: no credentials' } as never);
      emit({ type: 'tool', id: 't2', status: 'started', name: 'Bash', text: 'Run sleep', command: 'sleep 600' } as never);
    };
    const session = await runtime.start({ agent: 'claude', projectId: null, prompt: 'go' });
    await runtime.idle(session.id);
    expect(runtime.commands.list(session.id).map((c) => [c.command, c.status]).sort()).toEqual([['sleep 600', 'running'], ['terraform plan', 'failed']]);
    await runtime.shutdown();

    const script2 = new Script();
    const sent: string[] = [];
    const adapter2 = script2.adapter();
    const runtime2 = new SessionRuntime(new Workspace(db), { claude: { ...adapter2, resume: (id, options, emit) => ({ ...adapter2.resume(id, options, emit), send: (text: string) => void sent.push(text) }) } }, data);
    await runtime2.recoverAfterRestart();
    const snap = (await runtime2.snapshot(session.id))!;
    expect(snap.commands!.map((c) => [c.command, c.status]).sort()).toEqual([['sleep 600', 'stopped'], ['terraform plan', 'failed']]);
    const failed = snap.commands!.find((c) => c.command === 'terraform plan')!;
    expect((await runtime2.commandOutput(session.id, failed.id)).text).toBe('Error: no credentials');

    // Retry: the agent gets the command and how it failed, as a message from the user.
    expect(await runtime2.retryCommand(session.id, failed.id)).toBe('sent');
    // (The notice that the restart cut its turn off travels with it, ahead of the message.)
    expect(sent.at(-1)).toMatch(/Run this command again:\n\n```\nterraform plan\n```\n\nIt failed last time\. The end of what it printed:\n\n```\nError: no credentials\n```/);
    await expect(runtime2.retryCommand(session.id, 'nope')).rejects.toThrow(/not listed/);
  });
});

describe('restart handling', () => {
  it('tells an agent whose turn was cut off, once, and says which question went unanswered', async () => {
    const { db, workspace, runtime, script, data } = await setup();
    script.turn = () => undefined; // a turn that is still running when the server stops
    const working = await runtime.start({ agent: 'claude', projectId: null, prompt: 'go' });
    await runtime.idle(working.id);
    expect((await workspace.state()).sessions.find((s) => s.id === working.id)!.state).toBe('running');
    script.turn = (_o, emit) => emit({ type: 'needs-input', request: { id: 'q1', kind: 'question', title: 'Which database?', detail: 'Which database?', tool: '', options: [{ id: 'a', label: 'SQLite', role: 'choice' }] } });
    const asking = await runtime.start({ agent: 'claude', projectId: null, prompt: 'ask' });
    await runtime.idle(asking.id);
    await runtime.shutdown();

    const workspace2 = new Workspace(db);
    const runtime2 = new SessionRuntime(workspace2, { claude: new Script().adapter() }, data);
    expect(await runtime2.recoverAfterRestart()).toBe(2);
    expect((await workspace2.storedDetail(working.id))!.inbox).toEqual([expect.stringMatching(/restarted while you were working.*cut off/)]);
    expect((await workspace2.storedDetail(asking.id))!.inbox).toEqual([expect.stringMatching(/your question "Which database\?".*never answered/)]);
    // A second restart before anyone replies does not say it twice.
    const runtime3 = new SessionRuntime(new Workspace(db), { claude: new Script().adapter() }, data);
    expect(await runtime3.recoverAfterRestart()).toBe(0);
    expect((await workspace2.storedDetail(working.id))!.inbox).toHaveLength(1);
  });

  it('marks running sessions interrupted, abandons open prompts, and resumes through the adapter on reply', async () => {
    const { db, workspace, runtime, script, data } = await setup();
    script.turn = (_o, emit) => emit({ type: 'needs-input', request: { id: 'r1', kind: 'approval', title: 'Write x', detail: 'x', tool: 'Write', options: [{ id: 'allow', label: 'Allow', role: 'allow' }] } });
    const project = await runtime.registerProject(makeRepo());
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'go' });
    await runtime.idle(session.id);
    expect((await workspace.state()).sessions.find((s) => s.id === session.id)!.state).toBe('attention');
    await runtime.shutdown();

    // A new server process over the same store.
    const script2 = new Script();
    const workspace2 = new Workspace(db);
    const runtime2 = new SessionRuntime(workspace2, { claude: script2.adapter() }, data);
    expect(await runtime2.recoverAfterRestart()).toBe(1);
    const interrupted = (await workspace2.state()).sessions.find((s) => s.id === session.id)!;
    expect(interrupted.state).toBe('interrupted');
    expect((await workspace2.detail(session.id))!.messages.find((m) => m.input)!.input!.resolved).toMatch(/restart/);
    // The request cannot be asked again by Kestrel, so the agent is told which one was lost, with its next turn.
    const news = (await workspace2.storedDetail(session.id))!.inbox!;
    expect(news).toHaveLength(1);
    expect(news[0]).toMatch(/restarted while you were waiting for the user's answer to "Write x" \(Write\)/);
    expect(news[0]).toMatch(/did not run/);

    await runtime2.reply(session.id, 'carry on');
    await runtime2.idle(session.id);
    expect(script2.resumes).toHaveLength(1);
    expect(script2.resumes[0]!.id).toBe('agent-1');
    expect(script2.resumes[0]!.options.directory).toBe(interrupted.worktreePath);
    expect((await workspace2.state()).sessions.find((s) => s.id === session.id)!.landedIn).toBe(project.id);
    expect((await workspace2.detail(session.id))!.messages.some((m) => m.text === 'carry on')).toBe(true);
  });

  it('leaves sample sessions alone and says why they cannot take a reply', async () => {
    const { workspace, runtime } = await setup();
    const fake = await workspace.addSession({ title: 'Sample', agent: 'claude', startedIn: null, state: 'running' });
    expect(await runtime.recoverAfterRestart()).toBe(0);
    expect((await workspace.state()).sessions.find((s) => s.id === fake.id)!.state).toBe('running');
    await expect(runtime.reply(fake.id, 'hi')).rejects.toThrow(/no agent behind it/);
  });

  it('queues the user’s reply while the agent is working, but refuses a notice', async () => {
    const { runtime, script } = await setup();
    script.turn = () => undefined;
    const session = await runtime.start({ agent: 'claude', projectId: null, prompt: 'x' });
    await expect(runtime.reply(session.id, 'more')).resolves.toBe('queued');
    await expect(runtime.reply(session.id, 'news', {}, { notice: true })).rejects.toThrow(/still working/);
  });
});

describe('the latest update shown while a session works', () => {
  it('turns a message into one short line', async () => {
    const { noteFromText } = await import('./runtime.ts');
    expect(noteFromText('\n## Reading the config\nmore text')).toBe('Reading the config');
    expect(noteFromText('**Done.** I changed `a.ts`.')).toBe('Done. I changed a.ts.');
    expect(noteFromText('x'.repeat(300))).toHaveLength(120);
  });
});

describe('sub-agents', () => {
  it('travel on the session channel, not the workspace state, and move under the next user message while one still runs', async () => {
    const { runtime, script, workspace } = await setup();
    const project = await runtime.registerProject(makeRepo());
    const patches: object[] = [];
    runtime.onLive((_id, patch) => patches.push(patch));
    // First turn: one helper starts and reports, another starts and is still running at the end.
    script.turn = (_o, emit) => {
      emit({ type: 'tool', id: 'a1', name: 'Agent', summary: 'Check the last commit', status: 'started' });
      emit({ type: 'subagent-output', id: 'a1', text: '› Run git log' });
      emit({ type: 'tool', id: 'a1', name: 'Agent', summary: 'Check the last commit', status: 'finished', detail: 'Friday' });
      emit({ type: 'tool', id: 'a2', name: 'Agent', summary: 'Read the docs', status: 'started' });
      emit({ type: 'done', reason: 'complete' });
    };
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'look into it' });
    await runtime.idle(session.id);

    const snapshot = (await runtime.snapshot(session.id))!;
    expect(snapshot.subagents!.map((a) => `${a.title}:${a.status}`)).toEqual(['Check the last commit:done', 'Read the docs:running']);
    expect(snapshot.subagents![0]!.output).toBe('› Run git log\n\nReturned:\nFriday');
    const anchor = snapshot.subagentsAfter;
    expect(snapshot.messages!.some((m) => m.id === anchor)).toBe(true);
    expect(patches.some((p) => 'subagents' in p)).toBe(true);
    // Nothing about helpers is in the state every client receives.
    expect(JSON.stringify(await workspace.state())).not.toContain('Check the last commit');

    // The user writes again while one helper is still running: the card moves under that message.
    script.turn = (_o, emit) => emit({ type: 'done', reason: 'complete' });
    await runtime.reply(session.id, 'any news?');
    await runtime.idle(session.id);
    const after = (await runtime.snapshot(session.id))!;
    expect(after.subagentsAfter).not.toBe(anchor);
    expect(after.messages!.find((m) => m.id === after.subagentsAfter)).toMatchObject({ author: 'you', text: 'any news?' });
  });
});

describe('sub-agent cards across turns', () => {
  it('a finished card stays put, and the next turn\'s helper starts a new one', async () => {
    const { runtime, script } = await setup();
    const project = await runtime.registerProject(makeRepo());
    script.turn = (_o, emit) => {
      emit({ type: 'tool', id: 'a1', name: 'Agent', summary: 'First helper', status: 'started' });
      emit({ type: 'tool', id: 'a1', name: 'Agent', summary: 'First helper', status: 'finished' });
      emit({ type: 'done', reason: 'complete' });
    };
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'one' });
    await runtime.idle(session.id);
    const first = (await runtime.snapshot(session.id))!;

    script.turn = (_o, emit) => emit({ type: 'done', reason: 'complete' });
    await runtime.reply(session.id, 'thanks');
    await runtime.idle(session.id);
    const quiet = (await runtime.snapshot(session.id))!;
    expect(quiet.subagentsAfter).toBe(first.subagentsAfter);
    expect(quiet.subagents!.map((a) => a.title)).toEqual(['First helper']);

    script.turn = (_o, emit) => {
      emit({ type: 'tool', id: 'b1', name: 'Agent', summary: 'Second helper', status: 'started' });
      emit({ type: 'done', reason: 'complete' });
    };
    await runtime.reply(session.id, 'again');
    await runtime.idle(session.id);
    const second = (await runtime.snapshot(session.id))!;
    expect(second.subagents!.map((a) => a.title)).toEqual(['Second helper']);
    expect(second.subagentsAfter).not.toBe(first.subagentsAfter);
  });
});

describe('timing turns', () => {
  it('stores when each turn started and ended on the message that started it', async () => {
    let clock = 10_000;
    const { runtime, script, workspace } = await setup(() => clock);
    script.turn = (_o, emit) => {
      clock += 48_000;
      emit({ type: 'message', id: 'm1', text: 'Done.', delta: 'Done.', done: true });
      emit({ type: 'done', reason: 'complete' });
    };
    const session = await runtime.start({ agent: 'claude', projectId: null, prompt: 'one' });
    await runtime.idle(session.id);
    clock = 100_000;
    script.turn = (_o, emit) => {
      clock += 2_000;
      emit({ type: 'failed', reason: 'no', kind: 'other' });
    };
    await runtime.reply(session.id, 'two');
    await runtime.idle(session.id);
    const users = (await workspace.storedDetail(session.id))!.messages.filter((m) => m.author === 'you');
    expect(users.map((m) => [m.sentAt, m.turnEndedAt])).toEqual([
      [10_000, 58_000],
      [100_000, 102_000],
    ]);
  });
});

describe('the user\'s own agent setup', () => {
  it('a project session gets the user\'s and the project\'s settings by default, and no MCP servers until one is switched on', async () => {
    const { runtime, script, workspace } = await setup();
    const project = await runtime.registerProject(makeRepo());
    await runtime.idle((await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'a' })).id);
    expect(script.starts[0]!.options.setup).toEqual({ loadSettings: true, inProject: true, mcpServers: {} });
    await workspace.setProjectSetup(project.id, { loadSettings: false, mcpServers: ['not-configured-anywhere'] });
    await runtime.idle((await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'b' })).id);
    // Switched off, and a server name that no longer exists is simply not started.
    expect(script.starts[1]!.options.setup).toEqual({ loadSettings: false, inProject: true, mcpServers: {} });
  });
  it('a session with no project gets the user\'s settings and no project ones', async () => {
    const { runtime, script } = await setup();
    await runtime.start({ agent: 'claude', projectId: null, prompt: 'look' });
    expect(script.starts[0]!.options.setup).toEqual({ loadSettings: true, inProject: false, mcpServers: {} });
  });
});

describe('branch name prefix', () => {
  it('names a new session branch with the prefix from Settings → Git, and with none', async () => {
    const { workspace, runtime } = await setup();
    const repo = makeRepo();
    const project = await runtime.registerProject(repo);
    await runtime.gitPrefs.setBranchPrefix({ choice: 'custom', custom: 'team/me' });
    const custom = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Create hello.txt' });
    await runtime.idle(custom.id);
    await runtime.gitPrefs.setBranchPrefix({ choice: 'none', custom: 'team/me' });
    const bare = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Create hello.txt' });
    await runtime.idle(bare.id);
    const branchOf = async (id: string) => (await workspace.state()).sessions.find((s) => s.id === id)!.branch;
    expect(await branchOf(custom.id)).toMatch(/^team\/me\/create-hello-txt-[0-9a-f]{8}$/);
    expect(await branchOf(bare.id)).toMatch(/^create-hello-txt-[0-9a-f]{8}$/);
  });
});
