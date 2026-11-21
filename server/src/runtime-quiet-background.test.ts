// A session whose agent finished talking but left work running in the background (a `phase` event):
// it reads as done, takes a message at once (into the same run), flushes what was queued, goes back
// to working when the agent wakes by itself, and ends its run later without a second "done".
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentHandle } from './agents/types.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { SessionRuntime } from './runtime.ts';
import { Workspace } from './workspace.ts';

const SERVER = { id: 'b1', kind: 'command' as const, description: 'pnpm dev', label: 'Start the dev server' };

/** An agent the test drives: `busy` is what the handle says; `sent` is every message it was given. */
function agent() {
  const seen = { emit: null as ((e: AgentEvent) => void) | null, busy: false, sent: [] as string[] };
  const handle: AgentHandle = {
    agentSessionId: () => 'agent-1',
    busy: () => seen.busy,
    send: (text) => {
      if (seen.busy) throw new Error('The agent is still working on the previous message.');
      seen.sent.push(text);
      seen.busy = true;
    },
    answer: () => undefined,
    stop: async () => undefined,
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

async function setup() {
  const { seen, adapter } = agent();
  const workspace = new Workspace(memoryPersistence());
  const states: string[] = [];
  const setState = workspace.setState.bind(workspace);
  workspace.setState = (id, state, note, opts) => {
    states.push(state);
    return setState(id, state, note, opts);
  };
  const runtime = new SessionRuntime(workspace, { claude: adapter }, realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-quiet-'))));
  const session = await runtime.start({ agent: 'claude', projectId: null, prompt: 'start the dev server' });
  /** The agent says something; the runtime finishes what it does about it. */
  const emit = async (event: AgentEvent) => {
    seen.emit!(event);
    await runtime.idle(session.id);
  };
  /** The agent goes quiet with the server still running, as the Claude adapter does. */
  const quiet = async () => {
    seen.busy = false;
    await emit({ type: 'phase', phase: 'background' });
  };
  const state = async () => (await workspace.state()).sessions.find((s) => s.id === session.id)!.state;
  await runtime.idle(session.id);
  return { runtime, session, seen, emit, quiet, state, states };
}

describe('a session quiet on background work', () => {
  it('reads as done, keeps its background list, and takes a message straight away', async () => {
    const { runtime, session, seen, emit, quiet, state } = await setup();
    await emit({ type: 'background-tasks', tasks: [SERVER] });
    await quiet();
    expect(await state()).toBe('done');
    expect(runtime.background.list(session.id).map((t) => t.id)).toEqual(['b1']);
    expect(await runtime.reply(session.id, 'is it up?')).toBe('sent');
    expect(seen.sent).toEqual(['start the dev server', 'is it up?']);
    expect(await state()).toBe('running');
    expect(runtime.background.list(session.id).map((t) => t.id)).toEqual(['b1']);
  });

  it('sends what was queued while it worked as soon as it goes quiet', async () => {
    const { runtime, session, seen, quiet } = await setup();
    expect(await runtime.reply(session.id, 'then check the logs')).toBe('queued');
    await quiet();
    await runtime.idle(session.id);
    expect(seen.sent).toEqual(['start the dev server', 'then check the logs']);
    expect(runtime.overlay(session.id)?.queue?.items).toEqual([]);
  });

  it('ends its run later with no second done: the cost is counted and nothing is sent again', async () => {
    const { runtime, session, seen, emit, quiet, state, states } = await setup();
    await emit({ type: 'background-tasks', tasks: [SERVER] });
    await quiet();
    const before = [...states];
    await emit({ type: 'background-tasks', tasks: [] });
    await emit({ type: 'done', reason: 'complete', costUsd: 0.4 });
    expect(states).toEqual(before);
    expect(await state()).toBe('done');
    expect(runtime.overlay(session.id)!.usage).toEqual({ costUsd: 0.4, turns: 1 });
    expect(seen.sent).toEqual(['start the dev server']);
  });

  it('is working again when the agent wakes by itself, and a message written then is queued', async () => {
    const { runtime, session, seen, emit, quiet, state } = await setup();
    await emit({ type: 'background-tasks', tasks: [SERVER] });
    await quiet();
    seen.busy = true;
    await emit({ type: 'phase', phase: 'working' });
    expect(await state()).toBe('running');
    expect(await runtime.reply(session.id, 'wait')).toBe('queued');
    // That turn ends the run: a full done, and the queue goes.
    seen.busy = false;
    await emit({ type: 'done', reason: 'complete', costUsd: 0.1 });
    await runtime.idle(session.id);
    expect(seen.sent).toEqual(['start the dev server', 'wait']);
  });

  it('cannot be stopped as a session: its work is stopped from the strip', async () => {
    const { runtime, session, emit, quiet } = await setup();
    await emit({ type: 'background-tasks', tasks: [SERVER] });
    await quiet();
    await expect(runtime.stop(session.id)).rejects.toThrow('not running');
  });
});
