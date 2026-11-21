// "Re-run command" on a background command the user stopped (live, 2026-11-19): the first run ended
// once the stopped command was gone, the re-run started a new, resumed run, and that CLI process
// never listed the new task before its turn ended. The turn must still end for the user (quiet on
// background work), not stay "Writing…" until the command finishes.
import { describe, expect, it } from 'vitest';
import { NO_TOOLS } from '../test-support.ts';
import type { AgentEvent } from '../types.ts';
import { claudeAdapter } from './index.ts';
import { InputChannel } from './input.ts';
import type { SdkLike } from './map.ts';
import { RunPhase } from './run-phase.ts';

const LOOP = 'for i in $(seq 1 30); do echo tick $i; sleep 1; done';
const stream = (event: unknown) => ({ type: 'stream_event', event, parent_tool_use_id: null });
const say = (id: string, reason = 'end_turn') => [stream({ type: 'message_start', message: { id } }), stream({ type: 'message_delta', delta: { stop_reason: reason } }), stream({ type: 'message_stop' })];
const callBackground = (id: string) => ({ type: 'assistant', message: { id: `m-${id}`, stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: LOOP, run_in_background: true } }] } });
const backgrounded = (id: string, task: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: `Command running in background with ID: ${task}. Output is being written to: /tmp/t/${task}.output` }] } });
const ended = (task: string, tool: string, status = 'completed') => ({ type: 'system', subtype: 'task_notification', task_id: task, tool_use_id: tool, status, output_file: '', summary: '' });
const result = { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0 };
const idle = { type: 'system', subtype: 'session_state_changed', state: 'idle' };
const listed = (...ids: string[]) => ({ type: 'system', subtype: 'background_tasks_changed', tasks: ids.map((task_id) => ({ task_id, task_type: 'local_bash', description: 'ticks' })) });

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('a background command started again in a new run', () => {
  it('ends the turn for the user although the CLI never listed the task', async () => {
    let feed: InputChannel<unknown> | null = null;
    const runQuery = ((args: { prompt: AsyncIterable<unknown> }) => {
      feed = new InputChannel<unknown>();
      void (async () => {
        for await (const _ of args.prompt);
      })();
      const out = feed;
      return Object.assign((async function* () { for await (const m of out) yield m; })(), { interrupt: async () => out.close() });
    }) as any;
    const events: AgentEvent[] = [];
    const handle = claudeAdapter(runQuery).resume('s', { directory: '/w', permission: 'ask', instruction: 'x', tools: NO_TOOLS }, (e) => events.push(e));
    handle.send('Run this command again: … Run it in the background, as it ran before, and do not wait for it to finish.');
    await settle();
    const push = async (...m: unknown[]) => {
      for (const x of m) feed!.push(x);
      await settle();
    };
    // The resumed CLI first reports the stopped command from the previous process as ended.
    await push(ended('b1', 't-old', 'stopped'), callBackground('t2'), backgrounded('t2', 'b2'), ...say('m2'), result, idle);
    expect(events.filter((e) => e.type === 'phase')).toEqual([{ type: 'phase', phase: 'background' }]);
    expect(handle.busy()).toBe(false);
    expect(events.some((e) => e.type === 'done')).toBe(false);
    // The command ends; the CLI wakes the agent, which says so, and the run is over.
    await push(ended('b2', 't2'), ...say('m3'), result, idle);
    feed!.close();
    await settle();
    expect(events.filter((e) => e.type === 'phase')).toEqual([{ type: 'phase', phase: 'background' }, { type: 'phase', phase: 'working' }]);
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'complete' });
  });
});

describe('the run phase counts backgrounded calls as well as the CLI list', () => {
  const see = (phase: RunPhase, ...m: unknown[]) => m.flatMap((x) => phase.see(x as SdkLike) ?? []);

  it('a backgrounded call keeps the run open until the CLI says it ended, even when the list says nothing is alive', () => {
    const phase = new RunPhase();
    expect(see(phase, callBackground('t1'), backgrounded('t1', 'b1'), listed(), ...say('m'), result)).toEqual(['background']);
    expect(see(phase, ended('b1', 't1'), idle)).toEqual(['over']);
  });

  it('a backgrounded call that failed to start keeps nothing open', () => {
    const phase = new RunPhase();
    const failed = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'no' }] } };
    expect(see(phase, callBackground('t1'), failed, ...say('m'), result)).toEqual(['over']);
  });

  it('a task ending by task_updated, tied to its call by task_started, ends it too', () => {
    const phase = new RunPhase();
    const started = { type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 't1' };
    expect(see(phase, callBackground('t1'), backgrounded('t1', 'b1'), started, ...say('m'), result)).toEqual(['background']);
    expect(see(phase, { type: 'system', subtype: 'task_updated', task_id: 'b1', patch: { status: 'killed' } }, idle)).toEqual(['over']);
  });
});
