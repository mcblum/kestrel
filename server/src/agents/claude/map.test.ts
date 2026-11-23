import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KESTREL_TOOLS, type AgentEvent } from '../types.ts';
import { claudeInstalled, claudeSignInAdvice } from './sign-in.ts';

const CLAUDE_SIGN_IN = `${claudeSignInAdvice(claudeInstalled())} Then send again.`;
import { backgroundOutputFile, ClaudeMapper, kestrelToolsCheck, taskEnded, kestrelToolsStatus, listedTasks, type SdkLike, toolOrigin, unexpectedTools } from './map.ts';

function recorded(name: string): SdkLike[] {
  return readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

function run(messages: SdkLike[], cwd: string): AgentEvent[] {
  const mapper = new ClaudeMapper(cwd);
  return messages.flatMap((m) => mapper.map(m));
}

describe('Claude event mapping, from a recorded run', () => {
  const messages = recorded('write-approval');
  const cwd = (messages[0] as any).cwd as string;
  const events = run(messages, cwd);

  it('starts with the agent session id; this older recording only had list_projects, so the rest are named as missing', () => {
    const started = events[0]!;
    expect(started).toMatchObject({ type: 'started', kestrelTools: 'missing', missing: ['add_project', 'handoff', 'move_to_project', 'delegate', 'spawn', 'session_status', 'ask_session', 'complete_workstream', 'wait_for', 'show_widget', 'send_file', 'next_step', 'post_review', 'start_review', 'suggest', 'ticket_read', 'ticket_update', 'browser_navigate', 'browser_read', 'browser_click', 'browser_type', 'browser_screenshot', 'browser_console', 'sim_list', 'sim_boot', 'sim_launch', 'sim_screenshot', 'sim_tap', 'sim_swipe', 'sim_pinch', 'sim_type', 'sim_key', 'sim_button', 'sim_open_url', 'sim_appearance'], model: 'claude-haiku-5-5' });
    expect((started as any).agentSessionId).toBe((messages[0] as any).session_id);
  });

  it('streams text as growing messages and ends with the full text marked done', () => {
    const texts = events.filter((e): e is Extract<AgentEvent, { type: 'message' }> => e.type === 'message');
    const partial = texts.filter((t) => !t.done);
    expect(partial.length).toBeGreaterThan(1);
    expect(partial.at(-1)!.text).toBe(partial.map((t) => t.delta).join(''));
    const final = texts.at(-1)!;
    expect(final.done).toBe(true);
    expect(final.text).toContain('hello.txt');
    expect(final.text.startsWith(partial.at(-1)!.text)).toBe(true);
    expect(new Set(texts.map((t) => t.id)).size).toBe(1);
    expect(final.id).toMatch(/^msg_.+:0$/);
  });

  it('reports each tool when it starts and when it ends, with a short summary', () => {
    const tools = events.filter((e): e is Extract<AgentEvent, { type: 'tool' }> => e.type === 'tool');
    const write = tools.filter((t) => t.name === 'Write');
    expect(write.map((t) => t.status)).toEqual(['started', 'finished']);
    expect(write[0]!.summary).toBe('Write hello.txt');
    expect(write[1]!.summary).toBe('Write hello.txt');
    // The file it wrote, relative to the working folder, on both events: the conversation opens its diff.
    expect(write.map((t) => t.paths)).toEqual([['hello.txt'], ['hello.txt']]);
    expect(tools.find((t) => t.name === 'mcp__kestrel__list_projects')?.paths).toBeUndefined();
    const kestrel = tools.filter((t) => t.name === 'mcp__kestrel__list_projects');
    expect(kestrel.map((t) => t.status)).toEqual(['started', 'finished']);
    expect(kestrel[0]!.summary).toBe('Kestrel: list_projects');
    expect(kestrel[1]!.detail).toContain('demo');
  });

  it('signals files-changed once, after the Write finished', () => {
    const idx = events.flatMap((e, i) => (e.type === 'files-changed' ? [i] : []));
    expect(idx).toHaveLength(1);
    const finished = events.findIndex((e) => e.type === 'tool' && e.name === 'Write' && e.status === 'finished');
    expect(idx[0]).toBe(finished + 1);
  });

  it('says where the turn ends before it ends: the uuid of the last message of the main conversation (what forkSession’s upToMessageId takes)', () => {
    const main = messages.filter((m) => (m.type === 'assistant' || m.type === 'user') && !m.parent_tool_use_id && m.uuid);
    const points = events.filter((e) => e.type === 'turn-point');
    expect(points).toEqual([{ type: 'turn-point', point: main.at(-1)!.uuid }]);
    expect(events.at(-2)).toEqual(points[0]);
  });

  it('ends with done and the cost', () => {
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'complete' });
    expect((events.at(-1) as any).costUsd).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'failed')).toBe(false);
  });
});

describe('failures and warnings', () => {
  it('warns when the Kestrel server is not connected', () => {
    expect(kestrelToolsStatus({ type: 'system', mcp_servers: [{ name: 'kestrel', status: 'failed' }], tools: [] })).toBe('missing');
    expect(kestrelToolsStatus({ type: 'system', mcp_servers: [], tools: ['mcp__kestrel__list_projects'] })).toBe('missing');
  });

  it('maps an authentication error to a sign-in failure', () => {
    const events = run([{ type: 'assistant', error: 'authentication_failed', message: { id: 'm1', content: [{ type: 'text', text: 'Failed to authenticate' }] } }], '/w');
    expect(events).toEqual([{ type: 'failed', reason: `Failed to authenticate. ${CLAUDE_SIGN_IN}`, kind: 'auth' }]);
  });

  it('maps an error result to failed, and a failed tool result to a failed tool', () => {
    const mapper = new ClaudeMapper('/w');
    mapper.map({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'false' } }] } });
    const failedTool = mapper.map({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'exit 1' }] } });
    expect(failedTool).toEqual([{ type: 'tool', id: 't1', name: 'Bash', summary: 'Run false', status: 'failed', detail: 'exit 1' }]);
    expect(mapper.map({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] })).toEqual([{ type: 'failed', reason: 'boom', kind: 'other' }]);
  });
});

describe('message ids and sub-agents (synthetic fixtures)', () => {
  it('keeps two text blocks of one API message as two messages', () => {
    const texts = run(recorded('two-text-blocks'), '/w').filter((e): e is Extract<AgentEvent, { type: 'message' }> => e.type === 'message');
    expect([...new Set(texts.map((t) => t.id))]).toEqual(['msg_A:0', 'msg_A:2']);
    const finals = texts.filter((t) => t.done);
    expect(finals.map((t) => [t.id, t.text])).toEqual([['msg_A:0', 'First part.'], ['msg_A:2', 'Second.']]);
    expect(texts.filter((t) => t.id === 'msg_A:0' && !t.done).at(-1)!.text).toBe('First part.');
  });

  it('takes a turn’s end point from the main conversation, never from a helper’s messages, and says none when there is no uuid', () => {
    const mapper = new ClaudeMapper('/w');
    mapper.map({ type: 'assistant', uuid: 'main-1', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'text', text: 'Hi' }] } });
    mapper.map({ type: 'assistant', uuid: 'helper-1', parent_tool_use_id: 'task-1', message: { id: 'm2', content: [{ type: 'text', text: 'helping' }] } });
    expect(mapper.map({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0 })[0]).toEqual({ type: 'turn-point', point: 'main-1' });
    expect(new ClaudeMapper('/w').map({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0 }).some((e) => e.type === 'turn-point')).toBe(false);
  });

  it('keeps a sub-agent out of the conversation but still notices its file changes', () => {
    const events = run(recorded('sub-agent'), '/w');
    expect(events.filter((e) => e.type === 'message').map((e: any) => e.text)).toEqual(['All done.']);
    expect(events.filter((e) => e.type === 'tool').map((e: any) => [e.name, e.status])).toEqual([['Task', 'started'], ['Task', 'finished']]);
    expect(events.filter((e) => e.type === 'files-changed')).toHaveLength(1);
  });

  it('warns about tool servers Kestrel did not add', () => {
    const started = run(recorded('connector-warning'), '/w')[0] as Extract<AgentEvent, { type: 'started' }>;
    expect(started.warning).toMatch(/claude_ai_Gmail/);
    expect((run(recorded('write-approval'), '/w')[0] as any).warning).toBeUndefined();
  });
  it('does not warn about a server the user switched on, and still warns about one they did not', () => {
    const init = { type: 'system', mcp_servers: [{ name: 'kestrel', status: 'connected' }, { name: 'notes', status: 'connected' }, { name: 'stray', status: 'connected' }], tools: ['mcp__kestrel__handoff', 'mcp__notes__search', 'mcp__stray__send'] };
    expect(unexpectedTools(init, ['notes', 'stray'])).toBeUndefined();
    const spaced = { type: 'system', mcp_servers: [{ name: 'Home Assistant', status: 'connected' }], tools: ['mcp__Home_Assistant__ha_get_state'] };
    expect(unexpectedTools(spaced, ['Home Assistant'])).toBeUndefined();
    const warning = unexpectedTools(init, ['notes'])!;
    expect(warning).toMatch(/stray/);
    expect(warning).not.toMatch(/notes/);
  });
});

describe('the connected check', () => {
  const all = KESTREL_TOOLS.map((t) => `mcp__kestrel__${t}`);
  it('is connected only when the server is up and every tool is present', () => {
    expect(kestrelToolsCheck({ type: 'system', mcp_servers: [{ name: 'kestrel', status: 'connected' }], tools: all })).toEqual({ status: 'connected', missing: [] });
  });
  it('names exactly the missing tools', () => {
    expect(kestrelToolsCheck({ type: 'system', mcp_servers: [{ name: 'kestrel', status: 'connected' }], tools: all.filter((t) => !/spawn|delegate/.test(t)) })).toEqual({ status: 'missing', missing: ['delegate', 'spawn'] });
  });
  it('lists everything as missing when the server is not connected', () => {
    expect(kestrelToolsCheck({ type: 'system', mcp_servers: [{ name: 'kestrel', status: 'failed' }], tools: all }).missing).toEqual([...KESTREL_TOOLS]);
  });
});

describe('the task list and pictures', () => {
  const call = (id: string, name: string, input: unknown): SdkLike => ({ type: 'assistant', message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name, input }] } });
  const result = (id: string, content: unknown): SdkLike => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });

  it('turns TodoWrite into the whole list, with unknown statuses as pending', () => {
    const events = new ClaudeMapper('/w').map(call('t1', 'TodoWrite', { todos: [{ content: 'Read', status: 'completed' }, { content: 'Write', status: 'in_progress' }, { content: 'Ship', status: 'odd' }] }));
    expect(events).toEqual([{ type: 'todos', items: [{ text: 'Read', status: 'completed' }, { text: 'Write', status: 'in_progress' }, { text: 'Ship', status: 'pending' }] }]);
  });

  it('adds a created task once its result gives it an id, and passes updates through', () => {
    const mapper = new ClaudeMapper('/w');
    expect(mapper.map(call('c1', 'TaskCreate', { subject: 'Fix the bug', description: 'x' }))).toEqual([]);
    expect(mapper.map(result('c1', 'Task #7 created successfully: Fix the bug'))).toEqual([{ type: 'task', id: '7', text: 'Fix the bug', status: 'pending' }]);
    expect(mapper.map(call('u1', 'TaskUpdate', { taskId: '7', status: 'in_progress' }))).toEqual([{ type: 'task', id: '7', text: undefined, status: 'in_progress' }]);
    expect(mapper.map(call('u2', 'TaskUpdate', { taskId: '7', status: 'deleted' }))).toEqual([{ type: 'task', id: '7', text: undefined, status: 'deleted' }]);
  });

  it('never shows the task tools as steps, started or finished', () => {
    const mapper = new ClaudeMapper('/w');
    const events = [
      ...mapper.map(call('a', 'TodoWrite', { todos: [] })),
      ...mapper.map(result('a', 'ok')),
      ...mapper.map(call('b', 'TaskCreate', { subject: 's' })),
      ...mapper.map(result('b', 'Task #1 created')),
      ...mapper.map(call('c', 'TaskUpdate', { taskId: '1', status: 'completed' })),
      ...mapper.map(result('c', 'ok')),
    ];
    expect(events.filter((e) => e.type === 'tool')).toEqual([]);
  });

  it('passes on base64 pictures in a tool result, numbered per result, before the tool line', () => {
    const mapper = new ClaudeMapper('/w');
    mapper.map(call('s1', 'mcp__browser__screenshot', {}));
    const events = mapper.map(result('s1', [{ type: 'text', text: 'shot' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0K' } }, { type: 'image', source: { type: 'url', url: 'http://x' } }]));
    expect(events.filter((e) => e.type === 'image')).toEqual([{ type: 'image', id: 's1-0', mediaType: 'image/png', data: 'iVBORw0K' }]);
    expect(events.map((e) => e.type)).toEqual(['image', 'tool']);
  });
});

describe('the status line with background work', () => {
  const tasks = (...list: { description: string; ambient?: boolean }[]): SdkLike => ({ type: 'system', subtype: 'background_tasks_changed', tasks: list.map((t, i) => ({ task_id: `t${i}`, task_type: 'local_bash', ...t })) }) as SdkLike;
  const stream = (event: unknown): SdkLike => ({ type: 'stream_event', event }) as SdkLike;
  const text = [stream({ type: 'message_start', message: { id: 'm1' } }), stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })];
  const endTurn = [stream({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }), stream({ type: 'message_stop' })];
  const statuses = (messages: SdkLike[]) => run(messages, '/repo').filter((e) => e.type === 'status').map((e) => (e as { text: string }).text);

  it('says nothing about it: the agent quiet on background work is not working (run-phase.ts), and the strip lists the work', () => {
    expect(statuses([tasks({ description: 'Full test run' }), ...text, ...endTurn, tasks({ description: 'Watch CI' })])).toEqual(['Writing…']);
  });
});

describe('the list of background work', () => {
  const changed = (tasks: unknown[]): SdkLike => ({ type: 'system', subtype: 'background_tasks_changed', tasks }) as SdkLike;
  const lists = (messages: SdkLike[]) => run(messages, '/repo').filter((e) => e.type === 'background-tasks').map((e) => (e as Extract<AgentEvent, { type: 'background-tasks' }>).tasks);

  it('sends the whole list each time it changes, ending with an empty one', () => {
    const shell = { task_id: 'b1', task_type: 'local_bash', description: 'pnpm test' };
    expect(lists([changed([shell]), changed([])])).toEqual([[{ id: 'b1', kind: 'command', description: 'pnpm test' }], []]);
  });
  it('leaves out ambient watchers, helpers (they have their own card) and entries without an id', () => {
    expect(listedTasks([
      { task_id: 'w', task_type: 'monitor', description: 'Live updates', ambient: true },
      { task_id: 'h', task_type: 'local_agent', subagent_type: 'general-purpose', description: 'Explore' },
      { task_type: 'local_bash', description: 'no id' },
      { task_id: 'm', task_type: 'monitor', description: 'Watch CI' },
    ])).toEqual([{ id: 'm', kind: 'watcher', description: 'Watch CI' }]);
  });
});

describe('naming background work after the tool call that started it', () => {
  const call = (id: string, input: Record<string, unknown>): SdkLike => ({ type: 'assistant', message: { id: `msg-${id}`, content: [{ type: 'tool_use', id, name: 'Bash', input }] } }) as SdkLike;
  const changed = (tasks: unknown[]): SdkLike => ({ type: 'system', subtype: 'background_tasks_changed', tasks }) as SdkLike;
  const startedTask = (taskId: string, toolId: string): SdkLike => ({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: toolId, description: 'x' }) as SdkLike;
  const lists = (messages: SdkLike[]) => run(messages, '/repo').filter((e) => e.type === 'background-tasks').map((e) => (e as Extract<AgentEvent, { type: 'background-tasks' }>).tasks);
  const shell = { task_id: 'b1', task_type: 'local_bash', description: 'pnpm --filter @app/api dev' };

  it('takes the description and command of the Bash call, sending the list again once the task is tied to it', () => {
    const input = { command: 'pnpm --filter @app/api dev', description: 'Start the API dev server', run_in_background: true };
    // The SDK lists a task before its task_started, which is what ties it to the call.
    expect(lists([call('tu1', input), changed([shell]), startedTask('b1', 'tu1')])).toEqual([
      [{ id: 'b1', kind: 'command', description: 'pnpm --filter @app/api dev' }],
      [{ id: 'b1', kind: 'command', description: 'pnpm --filter @app/api dev', label: 'Start the API dev server', command: 'pnpm --filter @app/api dev', toolId: 'tu1' }],
    ]);
  });
  it('names a task tied before it is listed straight away, and does not resend for a repeat or an unknown call', () => {
    const named = lists([call('tu1', { command: 'npm run dev' }), startedTask('b1', 'tu1'), changed([shell]), startedTask('b1', 'tu1'), startedTask('b1', 'other')]);
    expect(named).toEqual([[{ id: 'b1', kind: 'command', description: 'pnpm --filter @app/api dev', command: 'npm run dev', toolId: 'tu1' }]]);
  });
  it('reads only a non-empty description and command from a tool input', () => {
    expect(toolOrigin({ command: 'ls', description: '  ' })).toEqual({ command: 'ls' });
    expect(toolOrigin({ file_path: '/x' })).toBeNull();
  });
});

describe('commands for the Commands pane', () => {
  const call = (id: string, name: string, input: unknown): SdkLike => ({ type: 'assistant', message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name, input }] } });
  const result = (id: string, content: unknown): SdkLike => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
  const tools = (events: AgentEvent[]) => events.filter((e) => e.type === 'tool') as Extract<AgentEvent, { type: 'tool' }>[];

  it('a shell call carries its command line and description; other tools carry none', () => {
    const mapper = new ClaudeMapper('/w');
    expect(tools(mapper.map(call('b1', 'Bash', { command: 'pnpm test', description: 'Run the tests' })))[0]).toMatchObject({ command: 'pnpm test', label: 'Run the tests' });
    expect(tools(mapper.map(call('r1', 'Read', { file_path: '/w/a.ts' })))[0]!.command).toBeUndefined();
  });

  it('a shell call sent to the background says so when it starts and when it returns', () => {
    const mapper = new ClaudeMapper('/w');
    expect(tools(mapper.map(call('b2', 'Bash', { command: 'pnpm dev', run_in_background: true })))[0]!.inBackground).toBe(true);
    expect(tools(mapper.map(result('b2', 'Command running in background with ID: x')))[0]!.inBackground).toBe(true);
  });

  it('listed background work names the tool call that started it', () => {
    const mapper = new ClaudeMapper('/w');
    mapper.map(call('b3', 'Bash', { command: 'pnpm dev', run_in_background: true }));
    mapper.map({ type: 'system', subtype: 'task_started', task_id: 'k1', tool_use_id: 'b3' } as SdkLike);
    const events = mapper.map({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'k1', task_type: 'local_bash', description: 'pnpm dev' }] } as SdkLike);
    expect(events).toEqual([{ type: 'background-tasks', tasks: [{ id: 'k1', kind: 'command', description: 'pnpm dev', command: 'pnpm dev', toolId: 'b3' }] }]);
  });

  it('a task notification says how the work ended', () => {
    const events = new ClaudeMapper('/w').map({ type: 'system', subtype: 'task_notification', task_id: 'k1', status: 'failed', output_file: '', summary: '' } as SdkLike);
    expect(events).toEqual([{ type: 'background-ended', taskId: 'k1', status: 'failed' }]);
  });
});

describe('background output files', () => {
  it('reads the file a backgrounded call names, and the one its end notice names', () => {
    const result = 'Command running in background with ID: bl5bbdm2j. Output is being written to: /private/tmp/claude-501/-w/s/tasks/bl5bbdm2j.output. You will be notified when it completes.';
    expect(backgroundOutputFile(result)).toBe('/private/tmp/claude-501/-w/s/tasks/bl5bbdm2j.output');
    expect(backgroundOutputFile('ok')).toBeUndefined();
    expect(taskEnded({ type: 'system', subtype: 'task_notification', task_id: 'k', status: 'completed', output_file: '/t/tasks/k.output', summary: '' } as SdkLike)).toEqual([{ type: 'background-ended', taskId: 'k', status: 'completed', outputFile: '/t/tasks/k.output' }]);
  });
});
