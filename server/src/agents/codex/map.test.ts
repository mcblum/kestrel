// The notification mapping, fed real (scrubbed) app-server traffic from fixtures/.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../types.ts';
import { CodexMapper, displayCommand, fileChanges, mcpResult, planTodos, turnEnd } from './map.ts';

type Line = { dir: 'in' | 'out'; msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown } };
const CWD = '/scratch/work';

function fixture(name: string): Line[] {
  return readFileSync(join(import.meta.dirname, 'fixtures', `${name}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Line);
}

/** Every notification Codex sent in a recording, through one mapper. */
function replay(name: string): { events: AgentEvent[]; mapper: CodexMapper; turn: unknown } {
  const mapper = new CodexMapper(CWD);
  const events: AgentEvent[] = [];
  let turn: unknown = null;
  for (const { dir, msg } of fixture(name)) {
    if (dir !== 'in' || !msg.method || msg.id !== undefined) continue;
    if (msg.method === 'turn/completed') turn = msg.params?.turn;
    else events.push(...mapper.map(msg.method, msg.params ?? {}));
  }
  return { events, mapper, turn };
}

const tools = (events: AgentEvent[]) => events.filter((e): e is Extract<AgentEvent, { type: 'tool' }> => e.type === 'tool');
const finalTexts = (events: AgentEvent[]) => events.filter((e) => e.type === 'message' && e.done).map((e) => (e as { text: string }).text);

describe('CodexMapper on recorded traffic', () => {
  it('a plain reply streams, then completes with the whole text', () => {
    const { events, turn } = replay('chat');
    const messages = events.filter((e): e is Extract<AgentEvent, { type: 'message' }> => e.type === 'message');
    expect(messages.some((m) => !m.done)).toBe(true);
    const last = messages.at(-1)!;
    expect(last.done).toBe(true);
    // The streamed deltas and the final delta add up to the final text.
    const streamed = messages.filter((m) => m.id === last.id && !m.done).map((m) => m.delta).join('');
    expect(streamed + last.delta).toBe(last.text);
    expect(turnEnd(turn, false, null)).toEqual({ type: 'done', reason: 'complete' });
  });

  it('Manual: a command is Bash with the command as typed, a new file is Write, and files-changed names it', () => {
    const { events, mapper } = replay('manual');
    const shown = tools(events);
    expect(shown.find((t) => t.name === 'Bash' && t.status === 'finished')?.summary).toContain('echo kestrel-hi');
    const write = shown.find((t) => t.name === 'Write' && t.status === 'finished');
    expect(write?.summary).toBe('Write a.txt');
    expect(write?.paths).toEqual(['a.txt']);
    expect(shown.find((t) => t.name === 'Bash')?.paths).toBeUndefined();
    expect(events).toContainEqual({ type: 'files-changed', paths: ['/scratch/work/a.txt'] });
    expect([...mapper.changes.values()].flat().map((c) => c.path)).toEqual(['/scratch/work/a.txt']);
  });

  it('a declined command shows as failed, says so, and reports no change', () => {
    const { events } = replay('decline');
    const bash = tools(events).find((t) => t.name === 'Bash' && t.status !== 'started');
    expect(bash).toMatchObject({ status: 'failed', detail: 'Declined.' });
    expect(events.some((e) => e.type === 'files-changed')).toBe(false);
  });

  it('a Kestrel tool call is mcp__kestrel__<tool>, as for Claude', () => {
    const { events } = replay('mcp');
    expect(tools(events).map((t) => [t.name, t.status])).toEqual([
      ['mcp__kestrel__list_projects', 'started'],
      ['mcp__kestrel__list_projects', 'finished'],
    ]);
  });

  it('an outside-folder file shows by its full path', () => {
    const write = tools(replay('outside').events).find((t) => t.name === 'Write' && t.status === 'finished');
    expect(write?.summary).toContain('outside/b.txt');
  });

  it("Auto: Codex's reviewer shows as status text", () => {
    const { events } = replay('auto');
    expect(events).toContainEqual({ type: 'status', text: 'Codex is reviewing an action…' });
    expect(tools(events).find((t) => t.status === 'finished')?.summary).toContain('auto.txt');
  });

  it('plan mode keeps the plan for the Plan ready card', () => {
    const { mapper } = replay('plan');
    expect(mapper.plan).toMatch(/^1\. Create `README\.md`/);
  });

  it('an interrupted turn is a stop when Kestrel asked for it, a failure otherwise', () => {
    const { turn } = replay('interrupt');
    expect(turnEnd(turn, true, null)).toEqual({ type: 'done', reason: 'stopped' });
    expect(turnEnd(turn, false, null)).toMatchObject({ type: 'failed', kind: 'other' });
  });

  it('a picture sent in is answered like any message', () => {
    expect(finalTexts(replay('image').events)).toEqual(['Red']);
  });
});

describe('mapping helpers', () => {
  it('fileChanges keeps where an update moves a file (the edit rule checks both ends)', () => {
    const item = { changes: [{ path: '/w/a.txt', kind: { type: 'update', move_path: '/other/a.txt' }, diff: '' }, { path: '/w/b.txt', kind: { type: 'update', move_path: null }, diff: '' }] };
    expect(fileChanges(item)).toEqual([
      { path: '/w/a.txt', kind: 'update', diff: '', movePath: '/other/a.txt' },
      { path: '/w/b.txt', kind: 'update', diff: '' },
    ]);
  });

  it('a change Kestrel refused shows the reason when Codex reports it declined', () => {
    const mapper = new CodexMapper('/w');
    mapper.map('item/started', { item: { type: 'fileChange', id: 'f1', changes: [{ path: '/other/a.txt', kind: { type: 'add' }, diff: 'x' }], status: 'inProgress' } });
    expect(mapper.refuse('f1', 'not from here')).toMatchObject({ type: 'tool', id: 'f1', status: 'failed', detail: 'not from here' });
    expect(mapper.map('item/completed', { item: { type: 'fileChange', id: 'f1', changes: [], status: 'declined' } })[0]).toMatchObject({ status: 'failed', detail: 'not from here' });
  });

  it('unwraps the login shell Codex runs a command in', () => {
    expect(displayCommand("/bin/zsh -lc 'echo hi'")).toBe('echo hi');
    expect(displayCommand("/bin/bash -lc 'echo '\"'\"'x'\"'\"''")).toBe("echo 'x'");
    expect(displayCommand('ls', [{ command: 'ls -la' }])).toBe('ls -la');
    expect(displayCommand('plain')).toBe('plain');
  });

  it('keeps the text and pictures of an MCP result', () => {
    expect(mcpResult({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'AAA', mimeType: 'image/jpeg' }, { type: 'text', text: 'b' }] })).toEqual({ text: 'ab', images: [{ mediaType: 'image/jpeg', data: 'AAA' }] });
    expect(mcpResult(null)).toEqual({ text: '', images: [] });
  });

  it('turns an MCP picture into an image event', () => {
    const mapper = new CodexMapper(CWD);
    const events = mapper.map('item/completed', { item: { type: 'mcpToolCall', id: 'm1', server: 'kestrel', tool: 'browser_screenshot', arguments: {}, status: 'completed', result: { content: [{ type: 'image', data: 'AAA', mimeType: 'image/png' }] } } });
    expect(events[0]).toEqual({ type: 'image', id: 'm1-0', mediaType: 'image/png', data: 'AAA' });
  });

  it("Codex's plan steps become the task list", () => {
    expect(planTodos([{ step: 'a', status: 'completed' }, { step: 'b', status: 'inProgress' }, { step: 'c', status: 'pending' }, { step: '', status: 'pending' }])).toEqual([
      { text: 'a', status: 'completed' },
      { text: 'b', status: 'in_progress' },
      { text: 'c', status: 'pending' },
    ]);
    expect(new CodexMapper(CWD).map('turn/plan/updated', { plan: [{ step: 'x', status: 'pending' }] })).toEqual([{ type: 'todos', items: [{ text: 'x', status: 'pending' }] }]);
  });

  it('an error Codex will retry is status; one it will not becomes the failed reason', () => {
    const mapper = new CodexMapper(CWD);
    expect(mapper.map('error', { error: { message: 'busy' }, willRetry: true })).toEqual([{ type: 'status', text: 'Retrying: busy' }]);
    expect(mapper.map('error', { error: { message: 'quota gone' }, willRetry: false })).toEqual([]);
    expect(turnEnd({ status: 'failed', error: null }, false, mapper.lastError)).toEqual({ type: 'failed', reason: 'quota gone', kind: 'other' });
  });

  it('an unauthorized turn is a sign-in failure that says what to run', () => {
    expect(turnEnd({ status: 'failed', error: { message: 'Your session expired.', codexErrorInfo: 'unauthorized' } }, false, null)).toEqual({
      type: 'failed',
      reason: 'Your session expired. Run `codex login` in a terminal, then send again.',
      kind: 'auth',
    });
  });
});

describe('command output', () => {
  it('passes on what a running command prints, and the command line it runs', () => {
    const mapper = new CodexMapper(CWD);
    const started = mapper.map('item/started', { item: { type: 'commandExecution', id: 'c1', command: 'pnpm test', commandActions: [] } });
    expect(started[0]).toMatchObject({ type: 'tool', id: 'c1', command: 'pnpm test' });
    expect(mapper.map('item/commandExecution/outputDelta', { threadId: 't', turnId: 'u', itemId: 'c1', delta: 'ok\n' })).toEqual([{ type: 'tool-output', id: 'c1', delta: 'ok\n' }]);
    expect(mapper.map('item/commandExecution/outputDelta', { itemId: 'c1', delta: '' })).toEqual([]);
  });
});
