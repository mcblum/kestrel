// Where a Claude run stands, from scripted SDK messages: busy, quiet on background work, or over.
import { describe, expect, it } from 'vitest';
import { RunPhase, type PhaseChange } from './run-phase.ts';
import type { SdkLike } from './map.ts';

const stream = (event: unknown, parent: string | null = null): SdkLike => ({ type: 'stream_event', event, parent_tool_use_id: parent }) as SdkLike;
const start = stream({ type: 'message_start', message: { id: 'm' } });
const stop = (reason: string) => [stream({ type: 'message_delta', delta: { stop_reason: reason } }), stream({ type: 'message_stop' })];
const endTurn = stop('end_turn');
const toolTurn = stop('tool_use');
const tasks = (...list: { ambient?: boolean }[]): SdkLike => ({ type: 'system', subtype: 'background_tasks_changed', tasks: list.map((t, i) => ({ task_id: `t${i}`, task_type: 'local_bash', description: 'x', ...t })) }) as SdkLike;
const result = (ok = true): SdkLike => ({ type: 'result', subtype: ok ? 'success' : 'error_during_execution', is_error: !ok }) as SdkLike;
const idle: SdkLike = { type: 'system', subtype: 'session_state_changed', state: 'idle' };

/** Feed messages in order; the changes they made, in order. */
function feed(phase: RunPhase, messages: SdkLike[]): PhaseChange[] {
  return messages.flatMap((m) => phase.see(m) ?? []);
}

describe('a run with nothing in the background', () => {
  it('is busy until its result, then over', () => {
    const phase = new RunPhase();
    expect(feed(phase, [start, ...toolTurn, start, ...endTurn])).toEqual([]);
    expect(phase.current).toBe('busy');
    expect(feed(phase, [result()])).toEqual(['over']);
    expect(phase.current).toBe('over');
  });

  it('is over on a failed result, and on the CLI saying it is idle', () => {
    expect(feed(new RunPhase(), [start, tasks({}), result(false)])).toEqual(['over']);
    expect(feed(new RunPhase(), [start, ...endTurn, idle])).toEqual(['over']);
  });

  it('is not over while a delivered message has not been answered', () => {
    const phase = new RunPhase();
    phase.delivered();
    expect(feed(phase, [tasks()])).toEqual([]);
    expect(phase.current).toBe('busy');
  });
});

describe('a run that leaves work in the background', () => {
  it('goes quiet when the agent finishes talking with work alive, and is over when the held result comes', () => {
    const phase = new RunPhase();
    expect(feed(phase, [start, ...toolTurn, tasks({}), start])).toEqual([]);
    expect(feed(phase, endTurn)).toEqual(['background']);
    expect(phase.current).toBe('background');
    // The work ends; the held result follows it.
    expect(feed(phase, [tasks()])).toEqual([]);
    expect(feed(phase, [result()])).toEqual(['over']);
  });

  it('goes quiet when the work starts only after the agent stopped talking, or when a result comes first', () => {
    expect(feed(new RunPhase(), [start, ...endTurn, tasks({})])).toEqual(['background']);
    expect(feed(new RunPhase(), [start, tasks({}), result()])).toEqual(['background']);
  });

  it('stays open when the CLI sends the result and idle at once while a command is still running (seen live)', () => {
    // The real sequence, SDK 0.3.322: the tool call, the task, the agent's question, then result and idle together.
    const phase = new RunPhase();
    expect(feed(phase, [start, ...toolTurn, tasks({}), start, ...endTurn])).toEqual(['background']);
    expect(feed(phase, [result(), idle])).toEqual([]);
    expect(phase.current).toBe('background');
    // The user answers the question while the command runs: it goes into this run.
    phase.delivered();
    expect(phase.current).toBe('busy');
    expect(feed(phase, [start, ...endTurn, result(), idle])).toEqual(['background']);
    // The command ends and the agent says nothing more: the run stays quiet, ready for a message.
    expect(feed(phase, [tasks()])).toEqual([]);
    expect(phase.current).toBe('background');
    // When the CLI does wake the agent, and that turn ends with nothing alive, the run is over.
    expect(feed(phase, [start])).toEqual(['working']);
    expect(feed(phase, [...endTurn, result(), idle])).toEqual(['over']);
  });

  it('goes quiet on idle alone when the stream said nothing, and a failed turn still ends the run', () => {
    expect(feed(new RunPhase(), [start, tasks({}), idle])).toEqual(['background']);
    expect(feed(new RunPhase(), [start, tasks({}), ...endTurn, result(false)])).toEqual(['background', 'over']);
  });

  it('does not go quiet for ambient watchers or for a pause to run a tool', () => {
    expect(feed(new RunPhase(), [start, tasks({ ambient: true }), ...endTurn])).toEqual([]);
    expect(feed(new RunPhase(), [start, tasks({}), ...toolTurn])).toEqual([]);
  });

  it('is busy with a message delivered while quiet, and quiet again once it is answered', () => {
    const phase = new RunPhase();
    feed(phase, [start, tasks({}), ...endTurn]);
    phase.delivered();
    expect(phase.current).toBe('busy');
    expect(feed(phase, [start])).toEqual([]); // the reply starting is not the agent waking on its own
    expect(feed(phase, endTurn)).toEqual(['background']);
  });

  it('says the agent woke on its own when it starts talking while quiet', () => {
    const phase = new RunPhase();
    feed(phase, [start, tasks({}), ...endTurn]);
    expect(feed(phase, [tasks(), start])).toEqual(['working']);
    expect(phase.current).toBe('busy');
    expect(feed(phase, [...endTurn, result()])).toEqual(['over']);
  });

  it("ignores a helper's own conversation", () => {
    const phase = new RunPhase();
    feed(phase, [start, tasks({}), ...endTurn]);
    expect(phase.see(stream({ type: 'message_start', message: { id: 'h' } }, 'agent-1'))).toBeNull();
    expect(phase.current).toBe('background');
  });

  it('takes nothing more once over', () => {
    const phase = new RunPhase();
    feed(phase, [start, ...endTurn, result()]);
    phase.delivered();
    expect(phase.current).toBe('over');
    expect(feed(phase, [start])).toEqual([]);
  });
});
