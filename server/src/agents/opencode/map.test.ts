// The event mapper on a turn recorded from the real `opencode serve` 1.14.25 (fixtures/recorded-turn.jsonl:
// a local model calls a Kestrel tool, then a write with bad arguments, then answers; paths replaced).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../types.ts';
import { OpencodeMapper, toTodos } from './map.ts';
import { turnEnd } from './turn-end.ts';

const SESSION = 'ses_e0b321ec1ffeA8HkCv6MA3S5bC';
const recorded = readFileSync(join(import.meta.dirname, 'fixtures', 'recorded-turn.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

function play(mapper: OpencodeMapper, events: Record<string, unknown>[]): AgentEvent[] {
  return events.flatMap((e) => mapper.map(e));
}

describe('OpencodeMapper on a recorded turn', () => {
  const mapper = new OpencodeMapper(SESSION, '/work/demo');
  mapper.beginTurn();
  const out = play(mapper, recorded);

  it("maps the Kestrel tool and the failed write, by OpenCode's call ids", () => {
    const tools = out.filter((e): e is Extract<AgentEvent, { type: 'tool' }> => e.type === 'tool');
    expect(tools.map((t) => [t.id, t.name, t.status])).toEqual([
      ['call_0zqk5zwe', 'mcp__kestrel__list_projects', 'started'],
      ['call_0zqk5zwe', 'mcp__kestrel__list_projects', 'finished'],
      ['call_dqxzhxq4', 'Write', 'started'],
      ['call_dqxzhxq4', 'Write', 'failed'],
    ]);
    expect(tools[3]!.detail).toMatch(/^The write tool was called with invalid arguments/);
  });

  it('streams the answer from deltas and ends it with the full text', () => {
    const messages = out.filter((e): e is Extract<AgentEvent, { type: 'message' }> => e.type === 'message');
    const final = messages.at(-1)!;
    expect(final.done).toBe(true);
    expect(final.text).toMatch(/^It looks like there was an issue/);
    expect(messages.filter((m) => !m.done).at(-1)!.text).toBe(final.text);
    expect(messages.slice(0, -1).map((m) => m.delta).join('')).toBe(final.text);
    expect(mapper.lastText).toBe(final.text);
  });

  it("does not show the user's own message, and keeps where the project root is and which model ran", () => {
    expect(out.some((e) => e.type === 'message' && e.text.startsWith('Do these steps'))).toBe(false);
    expect(mapper.root).toBe('/work/kestrel');
    expect(mapper.model).toBe('ollama/qwen2.5:7b-instruct');
  });

  it('reads the context the conversation occupies from the last step, and adds up every step\'s tokens', () => {
    // The two recorded steps: 4096 in, 158 out; 4096 in, 66 out (a local model: no cost, no cache).
    expect(mapper.usage).toEqual({ costUsd: 0, tokens: { input: 8192, output: 224 }, contextTokens: 4162 });
  });

  it("sends the turn's tokens with how it ended, though the model cost nothing", () => {
    expect(turnEnd({ error: null, text: '', costUsd: 0 }, false, null, 0, mapper.usage.tokens)).toEqual({ type: 'done', reason: 'complete', tokens: { input: 8192, output: 224 } });
    expect(turnEnd({ error: null, text: '', costUsd: 0 }, false, null, 0, null)).toEqual({ type: 'done', reason: 'complete' });
  });

  it('ignores another session’s events in the same folder', () => {
    const other = new OpencodeMapper('ses_other', '/work/demo');
    expect(play(other, recorded).filter((e) => e.type === 'message' || e.type === 'tool')).toEqual([]);
  });
});

describe('OpencodeMapper, the rest', () => {
  it('a refused call shows the reason now and when OpenCode reports it failed', () => {
    const mapper = new OpencodeMapper('s', '/w');
    const part = (status: string, extra: Record<string, unknown> = {}) => ({ type: 'message.part.updated', properties: { part: { id: 'p', sessionID: 's', messageID: 'm', type: 'tool', tool: 'edit', callID: 'c1', state: { status, input: { filePath: '/x/a.ts' }, ...extra } } } });
    mapper.map(part('running'));
    expect(mapper.refuse('c1', 'not here')).toEqual([expect.objectContaining({ id: 'c1', name: 'Edit', status: 'failed', detail: 'not here', refusal: 'not here' })]);
    expect(mapper.map(part('error', { error: 'The user rejected permission' }))).toEqual([expect.objectContaining({ status: 'failed', detail: 'not here', refusal: 'not here' })]);
  });

  it('an error on the session is kept for the failed turn', () => {
    const mapper = new OpencodeMapper('s', '/w');
    mapper.map({ type: 'session.error', properties: { sessionID: 's', error: { name: 'APIError', data: { message: 'Not Found' } } } });
    expect(mapper.lastError).toBe('Not Found');
    mapper.beginTurn();
    expect(mapper.lastError).toBeNull();
  });

  it('todos leave out cancelled items', () => {
    expect(toTodos([{ content: 'a', status: 'pending' }, { content: 'b', status: 'cancelled' }])).toEqual([{ text: 'a', status: 'pending' }]);
  });
});
