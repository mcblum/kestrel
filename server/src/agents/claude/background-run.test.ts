// The Claude adapter with work left in the background, driven by a scripted query: a message sent
// while the agent is quiet on that work goes into the same query (no second query, nothing killed),
// the run ends once when the held result comes, and Stop ends everything.
import { describe, expect, it } from 'vitest';
import { NO_TOOLS } from '../test-support.ts';
import type { AgentEvent } from '../types.ts';
import { claudeAdapter } from './index.ts';
import { InputChannel } from './input.ts';

const options = { directory: '/w', permission: 'ask' as const, instruction: 'x', tools: NO_TOOLS };

const init = { type: 'system', subtype: 'init', session_id: 's', model: 'm', tools: [], mcp_servers: [] };
const stream = (event: unknown) => ({ type: 'stream_event', event, parent_tool_use_id: null });
const say = (id: string) => [stream({ type: 'message_start', message: { id } }), stream({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }), stream({ type: 'message_stop' })];
const tasks = (...ids: string[]) => ({ type: 'system', subtype: 'background_tasks_changed', tasks: ids.map((id) => ({ task_id: id, task_type: 'local_bash', description: 'pnpm dev' })) });
const result = (cost: number) => ({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: cost });

/** Lets the adapter and the scripted query take every step they can (no clock involved). */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A query the test feeds message by message; it records what the adapter writes into its input. */
function liveQuery() {
  const state = { queries: 0, received: [] as string[], inputEnded: false, interrupted: 0, stoppedTasks: [] as string[] };
  let out: InputChannel<unknown> | null = null;
  const runQuery = ((args: { prompt: AsyncIterable<any> }) => {
    state.queries++;
    const feed = new InputChannel<unknown>();
    out = feed;
    void (async () => {
      for await (const m of args.prompt) state.received.push(m.message.content);
      state.inputEnded = true;
    })();
    const messages = (async function* () {
      for await (const m of feed) yield m;
    })();
    return Object.assign(messages, {
      interrupt: async () => {
        state.interrupted++;
        feed.close();
      },
      stopTask: async (id: string) => void state.stoppedTasks.push(id),
    });
  }) as any;
  /** The query says these messages, then the adapter takes its steps. */
  const send = async (...messages: unknown[]) => {
    for (const m of messages) out!.push(m);
    await settle();
  };
  /** The process ends: the query's message stream finishes. */
  const exit = async () => {
    out!.close();
    await settle();
  };
  return { runQuery, state, send, exit };
}

async function started() {
  const q = liveQuery();
  const events: AgentEvent[] = [];
  const handle = claudeAdapter(q.runQuery).start(options, 'start the dev servers', (e) => events.push(e));
  await settle();
  const of = (type: AgentEvent['type']) => events.filter((e) => e.type === type);
  return { q, events, handle, of };
}

describe('a message sent while the agent waits on background work', () => {
  it('goes into the same query while the work keeps running, and the run ends once', async () => {
    const { q, handle, of } = await started();
    expect(handle.busy()).toBe(true);
    await q.send(init, tasks('b1'), ...say('m1'));
    // Finished talking with a dev server alive: not busy, and said so.
    expect(handle.busy()).toBe(false);
    expect(of('phase')).toEqual([{ type: 'phase', phase: 'background' }]);
    expect(of('done')).toEqual([]);

    handle.send('is it up?');
    await settle();
    expect(q.state.queries).toBe(1);
    expect(q.state.received).toEqual(['start the dev servers', 'is it up?']);
    expect(q.state.inputEnded).toBe(false);
    expect(handle.busy()).toBe(true);
    expect(() => handle.send('again')).toThrow(/still working/);

    // It answers; still waiting on the server, it is quiet again (no second "started").
    await q.send(init, ...say('m2'));
    expect(handle.busy()).toBe(false);
    expect(of('phase')).toHaveLength(2);
    expect(of('started')).toHaveLength(1);

    // The user stops the server from the strip: the same query does it.
    await handle.stopBackgroundTask!('b1');
    expect(q.state.stoppedTasks).toEqual(['b1']);

    // The work ends and the held result comes: the input closes, and the run ends with one done carrying the running cost.
    await q.send(tasks(), result(0.25));
    expect(q.state.inputEnded).toBe(true);
    await q.exit();
    expect(of('done')).toEqual([{ type: 'done', reason: 'complete', costUsd: 0.25 }]);
    expect(handle.busy()).toBe(false);
    expect(q.state.interrupted).toBe(0);
  });

  it('works again when the agent wakes on its own, and a later message starts a fresh query', async () => {
    const { q, handle, of } = await started();
    await q.send(init, tasks('b1'), ...say('m1'));
    expect(handle.busy()).toBe(false);
    // The server exits; the agent reacts to it.
    await q.send(tasks(), stream({ type: 'message_start', message: { id: 'm2' } }));
    expect(of('phase').at(-1)).toEqual({ type: 'phase', phase: 'working' });
    expect(handle.busy()).toBe(true);
    await q.send(stream({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }), result(0.1));
    await q.exit();
    expect(of('done')).toHaveLength(1);
    handle.send('next');
    await settle();
    expect(q.state.queries).toBe(2);
  });

  it('closes the input as soon as a run with nothing in the background has its result', async () => {
    const { q, of } = await started();
    await q.send(init, ...say('m1'), result(0.05));
    expect(q.state.inputEnded).toBe(true);
    expect(of('phase')).toEqual([]);
    await q.exit();
    expect(of('done')).toEqual([{ type: 'done', reason: 'complete', costUsd: 0.05 }]);
  });
});

describe('ending a run that waits on background work', () => {
  it('Stop ends the run, background work and all, as stopped', async () => {
    const { q, handle, of } = await started();
    await q.send(init, tasks('b1'), ...say('m1'));
    await handle.stop();
    expect(q.state.interrupted).toBe(1);
    expect(q.state.inputEnded).toBe(true);
    expect(of('done')).toEqual([{ type: 'done', reason: 'stopped' }]);
  });

  it('close ends it without a word: the handle is being replaced', async () => {
    const { q, handle, events } = await started();
    await q.send(init, tasks('b1'), ...say('m1'));
    const before = events.length;
    await handle.close!();
    expect(q.state.interrupted).toBe(1);
    expect(events).toHaveLength(before);
  });

  it('a process that dies while work is in the background is a failure, not a quiet end', async () => {
    const q = liveQuery();
    const events: AgentEvent[] = [];
    const failing = ((args: any) => {
      const query = q.runQuery(args);
      const it = query[Symbol.asyncIterator]();
      return Object.assign(
        (async function* () {
          for (;;) {
            const next = await it.next();
            if (next.done) throw new Error('Claude Code process exited with code 1');
            yield next.value;
          }
        })(),
        { interrupt: query.interrupt },
      );
    }) as any;
    claudeAdapter(failing).start(options, 'go', (e) => events.push(e));
    await settle();
    await q.send(init, tasks('b1'), ...say('m1'), result(0.1));
    await q.exit();
    expect(events.filter((e) => e.type === 'failed')).toEqual([{ type: 'failed', reason: 'Claude Code process exited with code 1', kind: 'other' }]);
  });
});
