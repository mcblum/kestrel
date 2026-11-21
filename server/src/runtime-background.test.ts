// Background work an agent left running: kept live with when it was first seen, cleared when the
// agent's turn or process ends or the session is stopped, and stopped one task at a time.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BackgroundStopFailed, type AgentAdapter, type AgentEvent, type AgentHandle } from './agents/types.ts';
import type { ProcessSystem } from './runtime/kill-task.ts';
import type { LivePatch } from './model.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { SessionRuntime } from './runtime.ts';
import { Workspace } from './workspace.ts';

const SHELL = { id: 'b1', kind: 'command' as const, description: 'pnpm test' };
const WATCH = { id: 'w1', kind: 'watcher' as const, description: 'Watch CI' };

/** An agent whose turn stays open until the test ends it; `stoppable: false` has no way to stop background work (Codex). */
function agent(opts: { stoppable: boolean; stopFails?: string | Error }) {
  const seen = { emit: null as ((e: AgentEvent) => void) | null, stopped: [] as string[], busy: false };
  const handle: AgentHandle = {
    agentSessionId: () => 'agent-1',
    busy: () => seen.busy,
    send: () => void (seen.busy = true),
    answer: () => undefined,
    stop: async () => {
      seen.busy = false;
      seen.emit?.({ type: 'done', reason: 'stopped' });
    },
    ...(opts.stoppable
      ? {
          stopBackgroundTask: async (taskId: string) => {
            if (opts.stopFails) throw typeof opts.stopFails === 'string' ? new Error(opts.stopFails) : opts.stopFails;
            seen.stopped.push(taskId);
          },
        }
      : {}),
  };
  const adapter: AgentAdapter = {
    agent: 'claude',
    models: async () => ({ models: [{ id: '', label: 'Default' }], fromSdk: false }),
    start: (_options, prompt, emit) => {
      seen.emit = emit;
      emit({ type: 'started', agentSessionId: 'agent-1', model: 'fake', kestrelTools: 'connected' });
      handle.send(prompt);
      return handle;
    },
    resume: () => handle,
  };
  return { seen, adapter };
}

/** No real process is touched: `holders` is what holds a command's output file, and every signal is recorded. */
function fakeProcesses(holders: number[]) {
  const signals: [number, string][] = [];
  const alive = new Set(holders);
  const processes: ProcessSystem = {
    holders: async () => [...holders],
    table: async () => holders.map((pid) => ({ pid, ppid: 1, comm: '/bin/zsh' })),
    signal: (pid, signal) => (alive.has(pid) ? (signals.push([pid, signal]), alive.delete(pid)) : false),
    alive: (pid) => alive.has(pid),
    self: 99_999,
    sleep: async () => undefined,
  };
  return { processes, signals };
}

async function setup(opts: { stoppable: boolean; stopFails?: string | Error; holders?: number[] } = { stoppable: true }) {
  let now = 1_000_000;
  const { seen, adapter } = agent(opts);
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-bg-')));
  const killer = fakeProcesses(opts.holders ?? []);
  const runtime = new SessionRuntime(new Workspace(memoryPersistence()), { claude: adapter }, data, { now: () => now, processes: killer.processes });
  const patches: LivePatch[] = [];
  runtime.onLive((_id, patch) => void (patch.backgroundTasks && patches.push(patch)));
  const session = await runtime.start({ agent: 'claude', projectId: null, prompt: 'go' });
  const emit = (event: AgentEvent) => seen.emit!(event);
  const later = (ms: number) => void (now += ms);
  return { runtime, session, seen, emit, later, patches, signals: killer.signals, lastList: () => patches.at(-1)?.backgroundTasks };
}

describe('background work in a session', () => {
  it('sends the whole list, keeping when each task was first seen', async () => {
    const { runtime, session, emit, later, lastList } = await setup();
    emit({ type: 'background-tasks', tasks: [SHELL] });
    later(5_000);
    emit({ type: 'background-tasks', tasks: [SHELL, WATCH] });
    expect(lastList()).toEqual([{ ...SHELL, since: 1_000_000 }, { ...WATCH, since: 1_005_000 }]);
    expect((await runtime.snapshot(session.id))?.backgroundTasks).toEqual(lastList());
  });

  it('empties the list when the turn ends, and when the session is stopped', async () => {
    const ended = await setup();
    ended.emit({ type: 'background-tasks', tasks: [SHELL] });
    ended.emit({ type: 'done', reason: 'complete' });
    expect(ended.lastList()).toEqual([]);

    const stopped = await setup();
    stopped.emit({ type: 'background-tasks', tasks: [SHELL] });
    await stopped.runtime.stop(stopped.session.id);
    expect(stopped.lastList()).toEqual([]);
    expect(stopped.runtime.background.list(stopped.session.id)).toEqual([]);
  });

  it('starts over when the agent process starts again', async () => {
    const { emit, lastList } = await setup();
    emit({ type: 'background-tasks', tasks: [SHELL] });
    emit({ type: 'started', agentSessionId: 'agent-1', model: 'fake', kestrelTools: 'connected' });
    expect(lastList()).toEqual([]);
  });

  it('stops one task through the agent; the agent list, not the click, takes it off', async () => {
    const { runtime, session, seen, emit } = await setup();
    emit({ type: 'background-tasks', tasks: [SHELL, WATCH] });
    await runtime.stopBackgroundTask(session.id, 'w1');
    expect(seen.stopped).toEqual(['w1']);
    expect(runtime.background.list(session.id).map((t) => t.id)).toEqual(['b1', 'w1']);
  });

  it('refuses an unknown session or task, an agent that cannot stop it, and says why a stop failed', async () => {
    const { runtime, session, emit } = await setup();
    emit({ type: 'background-tasks', tasks: [SHELL] });
    await expect(runtime.stopBackgroundTask('nope', 'b1')).rejects.toThrow('No such session');
    await expect(runtime.stopBackgroundTask(session.id, 'gone')).rejects.toThrow('no longer running');

    const codex = await setup({ stoppable: false });
    codex.emit({ type: 'background-tasks', tasks: [SHELL] });
    await expect(codex.runtime.stopBackgroundTask(codex.session.id, 'b1')).rejects.toThrow('cannot stop background work');

    const failing = await setup({ stoppable: true, stopFails: 'task already ended' });
    failing.emit({ type: 'background-tasks', tasks: [SHELL] });
    await expect(failing.runtime.stopBackgroundTask(failing.session.id, 'b1')).rejects.toThrow('It could not be stopped: task already ended');
  });

  it('drops a sample task when it is stopped', async () => {
    const { runtime, session, lastList } = await setup();
    runtime.background.showSample(session.id, [{ ...SHELL, since: 1 }, { ...WATCH, since: 2 }]);
    await runtime.stopBackgroundTask(session.id, 'b1');
    expect(lastList()).toEqual([{ ...WATCH, since: 2 }]);
  });
});

describe('stopping a command when the agent cannot say it stopped it (0.0.18)', () => {
  const OUTPUT = '/tmp/claude-501/x/tasks/b1.output';
  /** A Bash call sent to the background whose result named its output file. */
  const backgrounded = (emit: (e: AgentEvent) => void) => {
    emit({ type: 'tool', id: 'call-1', name: 'Bash', summary: 'pnpm test', status: 'started', command: 'pnpm test' });
    emit({ type: 'tool', id: 'call-1', name: 'Bash', summary: 'pnpm test', status: 'finished', inBackground: true, outputFile: OUTPUT });
  };
  const row = (w: { runtime: SessionRuntime; session: { id: string } }) => w.runtime.commands.list(w.session.id).find((c) => c.id === 'call-1');

  it('a backgrounded command the agent never lists can still be stopped: its task id is in its output file', async () => {
    const w = await setup();
    backgrounded(w.emit);
    expect(row(w)).toMatchObject({ status: 'running', taskId: 'b1', unlisted: true });
    expect(row(w)!.noStop).toBeUndefined();
    // The agent's list (which leaves it out) does not end it.
    w.emit({ type: 'background-tasks', tasks: [WATCH] });
    expect(row(w)!.status).toBe('running');
    await w.runtime.stopCommand(w.session.id, 'call-1');
    expect(w.seen.stopped).toEqual(['b1']);
  });

  it('ends the processes itself when the agent does not answer, and the row says stopped', async () => {
    const w = await setup({ stoppable: true, stopFails: new BackgroundStopFailed('Claude did not answer within 4 seconds.', 'no-answer'), holders: [4242] });
    backgrounded(w.emit);
    w.emit({ type: 'background-tasks', tasks: [SHELL] });
    await w.runtime.stopCommand(w.session.id, 'call-1');
    expect(w.signals).toEqual([[4242, 'SIGTERM']]);
    expect(row(w)!.status).toBe('stopped');
    expect(w.runtime.background.list(w.session.id)).toEqual([]);
  });

  it('ends the processes itself when the agent does not know the task (an earlier process started it)', async () => {
    const w = await setup({ stoppable: true, stopFails: new BackgroundStopFailed('No task found with ID: b1', 'unknown'), holders: [4242] });
    backgrounded(w.emit);
    await w.runtime.stopBackgroundTask(w.session.id, 'b1');
    expect(w.signals).toEqual([[4242, 'SIGTERM']]);
    expect(row(w)!.status).toBe('stopped');
  });

  it('says it had already ended when nothing runs from it any more, and the row reflects that', async () => {
    const w = await setup({ stoppable: true, stopFails: new BackgroundStopFailed('No task found with ID: b1', 'unknown'), holders: [] });
    backgrounded(w.emit);
    await expect(w.runtime.stopCommand(w.session.id, 'call-1')).rejects.toThrow('Claude no longer knows this command (an earlier run of its process started it). Nothing is running from it any more');
    expect(row(w)!.status).toBe('stopped');
  });

  it('when the agent says it already ended, the row shows how, and the user is told', async () => {
    const w = await setup({ stoppable: true, stopFails: new BackgroundStopFailed('Task b1 is not running (status: completed)', 'ended', 'completed') });
    backgrounded(w.emit);
    w.emit({ type: 'background-tasks', tasks: [SHELL] });
    await expect(w.runtime.stopCommand(w.session.id, 'call-1')).rejects.toThrow('It had already ended (done), so there was nothing left to stop.');
    expect(row(w)!.status).toBe('completed');
    expect(w.runtime.background.list(w.session.id)).toEqual([]);
  });

  it('says exactly why when it cannot find the process either', async () => {
    const w = await setup({ stoppable: true, stopFails: new BackgroundStopFailed('Claude did not answer within 4 seconds.', 'no-answer') });
    w.emit({ type: 'background-tasks', tasks: [SHELL] });
    await expect(w.runtime.stopBackgroundTask(w.session.id, 'b1')).rejects.toThrow("Claude did not confirm stopping it. Kestrel cannot find the command's process to end it itself, so it may still be running.");
    expect(w.signals).toEqual([]);
  });

  it('still refuses a command that is not background work, with the reason', async () => {
    const w = await setup();
    w.emit({ type: 'tool', id: 'call-2', name: 'Bash', summary: 'pnpm build', status: 'started', command: 'pnpm build' });
    await expect(w.runtime.stopCommand(w.session.id, 'call-2')).rejects.toThrow('only stop this by stopping the whole turn');
  });
});
