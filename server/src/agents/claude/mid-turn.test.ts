// The Claude adapter with a message sent while the agent works, driven by a scripted query: the
// message goes into the same query's input at once (streaming input), is reported read when a frame of
// the turn names its uuid, keeps the run open while unread (the CLI runs it as the next turn), and is
// reported unread when the run ends without it (Stop).
import { describe, expect, it } from 'vitest';
import { NO_TOOLS } from '../test-support.ts';
import type { AgentEvent } from '../types.ts';
import { claudeAdapter } from './index.ts';
import { InputChannel } from './input.ts';
import { MidTurnInput } from './mid-turn.ts';

const options = { directory: '/w', permission: 'ask' as const, instruction: 'x', tools: NO_TOOLS };

const init = { type: 'system', subtype: 'init', session_id: 's', model: 'm', tools: [], mcp_servers: [] };
const stream = (event: unknown) => ({ type: 'stream_event', event, parent_tool_use_id: null });
const assistant = (stop: string, uuids: string[] = []) => ({ type: 'assistant', parent_tool_use_id: null, message: { id: `m-${stop}`, stop_reason: stop, content: [] }, ...(uuids.length ? { user_message_uuids: uuids } : {}) });
const result = (uuids: string[], queued = 0) => ({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, user_message_uuids: uuids, queued_turn_count: queued });

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A query the test feeds; it records each message the adapter writes into its input, uuid included. */
function liveQuery() {
  const state = { queries: 0, received: [] as { text: unknown; uuid: string }[], inputEnded: false, interrupted: 0 };
  let out: InputChannel<unknown> | null = null;
  const runQuery = ((args: { prompt: AsyncIterable<any> }) => {
    state.queries++;
    const feed = new InputChannel<unknown>();
    out = feed;
    void (async () => {
      for await (const m of args.prompt) state.received.push({ text: m.message.content, uuid: m.uuid });
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
    });
  }) as any;
  const send = async (...messages: unknown[]) => {
    for (const m of messages) out!.push(m);
    await settle();
  };
  /** The process ends: the query's message stream finishes (as it does once its input is closed and its last turn is done). */
  const exit = async () => {
    out!.close();
    await settle();
  };
  return { runQuery, state, send, exit };
}

async function started() {
  const q = liveQuery();
  const events: AgentEvent[] = [];
  const handle = claudeAdapter(q.runQuery).start(options, 'build it', (e) => events.push(e));
  await settle();
  await q.send(init, stream({ type: 'message_start', message: { id: 'a' } }));
  const of = <T extends AgentEvent['type']>(type: T) => events.filter((e) => e.type === type) as Extract<AgentEvent, { type: T }>[];
  return { q, events, handle, of };
}

describe('a message sent while Claude works', () => {
  it('goes into the same query at once, with a uuid, and is read when a frame names it', async () => {
    const { q, handle, of } = await started();
    await expect(handle.sendNow!({ id: 'k1', text: 'also add tests' })).resolves.toBe(true);
    await settle();
    expect(q.state.queries).toBe(1);
    expect(q.state.received.map((r) => r.text)).toEqual(['build it', 'also add tests']);
    const [first, mid] = q.state.received;
    expect(first!.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(of('picked-up')).toEqual([]);
    // The CLI folded it in between tool rounds: the next assistant frame lists it.
    await q.send(assistant('tool_use', [first!.uuid, mid!.uuid]));
    expect(of('picked-up')).toEqual([{ type: 'picked-up', ids: ['k1'] }]);
    await q.send(assistant('end_turn', [first!.uuid, mid!.uuid]), result([first!.uuid, mid!.uuid]));
    // Everything read: the run is over, its input closed.
    expect(q.state.inputEnded).toBe(true);
    await q.exit();
    expect(of('done')).toHaveLength(1);
    expect(of('unread')).toEqual([]);
  });

  it('keeps the run open when the turn ends before reading it, and the next turn of the run reads it', async () => {
    const { q, handle, of } = await started();
    await handle.sendNow!({ id: 'k1', text: 'one more thing' });
    await settle();
    const [first, mid] = q.state.received;
    await q.send(assistant('end_turn', [first!.uuid]), result([first!.uuid], 1));
    // Not over: the CLI runs the message as the next turn without more input.
    expect(of('done')).toEqual([]);
    expect(handle.busy()).toBe(true);
    expect(q.state.inputEnded).toBe(false);
    await q.send(stream({ type: 'message_start', message: { id: 'b' } }), assistant('end_turn', [mid!.uuid]));
    expect(of('picked-up')).toEqual([{ type: 'picked-up', ids: ['k1'] }]);
    await q.send(result([mid!.uuid]));
    expect(q.state.inputEnded).toBe(true);
    await q.exit();
    expect(of('done')).toHaveLength(1);
    expect(q.state.queries).toBe(1);
  });

  it('reports a message the agent never read as unread when the user stops, before the run ends', async () => {
    const { q, handle, events } = await started();
    await handle.sendNow!({ id: 'k1', text: 'never read' });
    await handle.stop();
    const tail = events.slice(-2);
    expect(tail).toEqual([{ type: 'unread', ids: ['k1'] }, { type: 'done', reason: 'stopped' }]);
    expect(q.state.interrupted).toBe(1);
  });

  it('refuses once the run is ending, and while no run is going', async () => {
    const { q, handle } = await started();
    await q.send(assistant('end_turn'), result([]));
    // The run is ending (its input closed) though the process has not exited yet.
    await expect(handle.sendNow!({ id: 'k1', text: 'late' })).resolves.toBe(false);
    await q.exit();
    expect(handle.busy()).toBe(false);
    await expect(handle.sendNow!({ id: 'k2', text: 'later' })).resolves.toBe(false);
    expect(q.state.received.map((r) => r.text)).toEqual(['build it']);
  });
});

describe('what the agent read of the messages sent mid-turn', () => {
  it('reads the uuids a frame lists, ignores a helper\'s frames, and lets an old CLI\'s result end the wait', () => {
    const input = new MidTurnInput();
    const a = input.sent('a');
    input.sent('b');
    expect(input.see({ type: 'assistant', parent_tool_use_id: 'task-1', user_message_uuids: [a] })).toEqual([]);
    expect(input.see({ type: 'assistant', user_message_uuid: a })).toEqual(['a']);
    expect(input.moreToCome).toBe(true);
    // A result without the fields (an older CLI): nothing is waited for, nothing is claimed read.
    expect(input.see({ type: 'result', subtype: 'success' })).toEqual([]);
    expect(input.moreToCome).toBe(false);
    expect(input.unread()).toEqual([]);
  });

  it('waits while the CLI says a turn follows', () => {
    const input = new MidTurnInput();
    input.see({ type: 'result', subtype: 'success', user_message_uuids: [], queued_turn_count: 2 });
    expect(input.moreToCome).toBe(true);
    input.see({ type: 'result', subtype: 'success', user_message_uuids: [], queued_turn_count: 0 });
    expect(input.moreToCome).toBe(false);
  });
});
