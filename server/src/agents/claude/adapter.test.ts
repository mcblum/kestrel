import { NO_TOOLS } from '../test-support.ts';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, InputRequest } from '../types.ts';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeAdapter, planFileWritten, planText } from './index.ts';

const options = { directory: '/w', permission: 'ask' as const, instruction: 'x', tools: NO_TOOLS };
const done = { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0 };

/** A scripted `query`: each call returns the messages of the next script, and records its options. */
function scripted(...scripts: any[][]) {
  const calls: any[] = [];
  const runQuery = ((args: any) => {
    calls.push(args.options);
    const messages = scripts[calls.length - 1] ?? [done];
    return Object.assign(
      (async function* () {
        for (const m of messages) yield m;
      })(),
      { interrupt: async () => undefined },
    );
  }) as any;
  return { runQuery, calls };
}

describe('turn state', () => {
  it('is idle by the time done is emitted, so an immediate next send is a fresh turn the first cannot clobber', async () => {
    const { runQuery, calls } = scripted([done], [{ type: 'system', subtype: 'init', session_id: 's', model: 'm', tools: [], mcp_servers: [] }, done]);
    const events: AgentEvent[] = [];
    let handle!: ReturnType<ReturnType<typeof claudeAdapter>['start']>;
    let secondStarted = false;
    const finished = new Promise<void>((resolve) => {
      handle = claudeAdapter(runQuery).start(options, 'one', (e) => {
        events.push(e);
        if (e.type === 'done' && !secondStarted) {
          secondStarted = true;
          expect(handle.busy()).toBe(false);
          handle.send('two'); // straight from the done handler
        } else if (e.type === 'done') resolve();
      });
    });
    await finished;
    expect(calls).toHaveLength(2);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(2);
    expect(handle.busy()).toBe(false);
    expect(handle.agentSessionId()).toBe('s');
  });

  it('refuses a send while a turn is running', () => {
    const never = (() => Object.assign((async function* () { await new Promise(() => undefined); })(), { interrupt: async () => undefined })) as any;
    const handle = claudeAdapter(never).start(options, 'x', () => undefined);
    expect(() => handle.send('y')).toThrow(/still working/);
  });
});

describe('AskUserQuestion', () => {
  async function ask(input: Record<string, unknown>) {
    let canUseTool: any;
    const runQuery = ((args: any) => {
      canUseTool = args.options.canUseTool;
      return Object.assign((async function* () { yield done; })(), { interrupt: async () => undefined });
    }) as any;
    const events: AgentEvent[] = [];
    const handle = claudeAdapter(runQuery).start(options, 'x', (e) => events.push(e));
    return { handle, events, call: () => canUseTool('AskUserQuestion', input, { signal: new AbortController().signal, toolUseID: 'q1' }) };
  }

  it('shows several questions, multi-select included, and passes back the answer to each', async () => {
    const { handle, events, call } = await ask({
      questions: [
        { question: 'Which colour?', header: 'Colour', options: [{ label: 'Red' }, { label: 'Blue', description: 'calmer' }] },
        { question: 'Which sizes?', multiSelect: true, options: [{ label: 'S' }, { label: 'M' }, { label: 'L' }] },
      ],
    });
    const pending = call();
    const request = (events.find((e) => e.type === 'needs-input') as { request: InputRequest }).request;
    expect(request.questions).toEqual([
      { question: 'Which colour?', header: 'Colour', multi: false, options: [{ label: 'Red', description: undefined }, { label: 'Blue', description: 'calmer' }] },
      { question: 'Which sizes?', header: undefined, multi: true, options: [{ label: 'S', description: undefined }, { label: 'M', description: undefined }, { label: 'L', description: undefined }] },
    ]);
    // More than one question is filled in and submitted, so there are no one-click choices.
    expect(request.options).toEqual([]);
    handle.answer('q1', { answers: { 'Which colour?': 'Blue', 'Which sizes?': 'S, L' } });
    expect(await pending).toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Which colour?': 'Blue', 'Which sizes?': 'S, L' } } });
  });

  it('shows one question and passes back exactly the answer given', async () => {
    const { handle, events, call } = await ask({ questions: [{ question: 'Which?', options: [{ label: 'Red' }, { label: 'Blue' }] }] });
    const pending = call();
    const request = (events.find((e) => e.type === 'needs-input') as { request: InputRequest }).request;
    expect(request).toMatchObject({ kind: 'question', detail: 'Which?' });
    handle.answer('q1', { optionId: '1' });
    expect(await pending).toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Which?': 'Blue' } } });
  });
});

describe('the plan shown on the card', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-plans-')));
  it('notes a plan file written or edited in the plans folder, and nothing else', () => {
    expect(planFileWritten('Write', { file_path: join(dir, 'p.md') }, dir)).toBe(join(dir, 'p.md'));
    expect(planFileWritten('Edit', { file_path: join(dir, 'p.md') }, dir)).toBe(join(dir, 'p.md'));
    expect(planFileWritten('Write', { file_path: join(dir, 'p.txt') }, dir)).toBeNull();
    expect(planFileWritten('Write', { file_path: join(dir, '..', 'p.md') }, dir)).toBeNull();
    expect(planFileWritten('Read', { file_path: join(dir, 'p.md') }, dir)).toBeNull();
  });
  it('is read from the plan file when the call carries none (the real SDK)', () => {
    writeFileSync(join(dir, 'p.md'), '# Plan\n\n1. Edit');
    expect(planText({}, join(dir, 'p.md'))).toBe('# Plan\n\n1. Edit');
  });
  it('prefers a plan in the call, and is empty with nothing to read', () => {
    expect(planText({ plan: 'inline' }, join(dir, 'p.md'))).toBe('inline');
    expect(planText({}, join(dir, 'missing.md'))).toBe('');
    expect(planText({})).toBe('');
  });
});

describe('ExitPlanMode', () => {
  async function plan() {
    let canUseTool: any;
    const runQuery = ((args: any) => {
      canUseTool = args.options.canUseTool;
      return Object.assign((async function* () { yield done; })(), { interrupt: async () => undefined });
    }) as any;
    const events: AgentEvent[] = [];
    const handle = claudeAdapter(runQuery).start({ ...options, permission: 'plan' as const }, 'x', (e) => events.push(e));
    const pending = canUseTool('ExitPlanMode', { plan: '# Plan\n\n1. Do it' }, { signal: new AbortController().signal, toolUseID: 'p1' });
    const request = (events.find((e) => e.type === 'needs-input') as { request: InputRequest }).request;
    return { handle, events, pending, request };
  }

  it('is a "Plan ready" card with the plan as markdown and three choices', async () => {
    const { request } = await plan();
    expect(request).toMatchObject({ kind: 'approval', tool: 'ExitPlanMode', title: 'Plan ready', detail: '# Plan\n\n1. Do it', markdown: true });
    expect(request.options.map((o) => o.id)).toEqual(['approve-edits', 'approve-ask', 'deny']);
  });

  it('approving leaves plan mode for the level picked, and says so', async () => {
    const { handle, events, pending } = await plan();
    handle.answer('p1', { optionId: 'approve-edits' });
    expect(events).toContainEqual({ type: 'mode', permission: 'edits' });
    expect(await pending).toMatchObject({ behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] });
  });

  it('keeping on planning denies with a reason and changes no mode', async () => {
    const { handle, events, pending } = await plan();
    handle.answer('p1', { optionId: 'deny' });
    expect(await pending).toMatchObject({ behavior: 'deny', message: expect.stringMatching(/keep planning/) });
    expect(events.some((e) => e.type === 'mode')).toBe(false);
  });
});

describe('PreToolUse hook', () => {
  function hookFor(opts: Record<string, unknown>) {
    let hook: any;
    const runQuery = ((args: any) => {
      hook = args.options.hooks.PreToolUse[0].hooks[0];
      return Object.assign((async function* () { yield done; })(), { interrupt: async () => undefined });
    }) as any;
    claudeAdapter(runQuery).start({ ...options, ...opts }, 'x', () => undefined);
    const verdict = async (tool_name: string, tool_input: Record<string, unknown>) => (await hook({ tool_name, tool_input }))?.hookSpecificOutput?.permissionDecision;
    return verdict;
  }

  it('refuses claude.ai connector tools and what an intercept refuses', async () => {
    const verdict = hookFor({ intercept: async (a: { tool: string }) => (a.tool === 'Bash' || a.tool === 'Edit' ? { allow: false, message: 'no' } : { allow: true }) });
    expect(await verdict('mcp__claude_ai_Gmail__send', {})).toBe('deny');
    expect(await verdict('Bash', { command: 'ls' })).toBe('deny');
    expect(await verdict('Edit', { file_path: '/elsewhere/x' })).toBe('deny'); // a refusal wins over asking
    expect(await verdict('Read', { file_path: '/etc/hosts' })).toBeUndefined();
  });

  it('never refuses an edit for where it is: outside the folder it asks in Manual and Accept edits, and is left to the mode otherwise', async () => {
    for (const permission of ['ask', 'edits'] as const) {
      const verdict = hookFor({ permission, readableDirectories: ['/p'] });
      expect(await verdict('Write', { file_path: '/w/x' })).toBeUndefined();
      expect(await verdict('Write', { file_path: '/elsewhere/x' })).toBe('ask');
      // A folder it was given to read is a working directory to the SDK, which would pass the edit in Accept edits.
      expect(await verdict('Edit', { file_path: '/p/x' })).toBe('ask');
      expect(await verdict('NotebookEdit', { notebook_path: '/elsewhere/n.ipynb' })).toBe('ask');
    }
    for (const permission of ['auto', 'bypass', 'plan'] as const) {
      expect(await hookFor({ permission })('Write', { file_path: '/elsewhere/x' })).toBeUndefined();
    }
  });

  it('always asks before a confined session runs a command outside its sandbox, whatever the mode', async () => {
    for (const permission of ['ask', 'edits', 'auto'] as const) {
      const verdict = hookFor({ permission, confineShell: true });
      expect(await verdict('Bash', { command: 'git commit -m x', dangerouslyDisableSandbox: true })).toBe('ask');
      expect(await verdict('Bash', { command: 'ls' })).toBeUndefined();
    }
    // A session that is not confined has no sandbox to leave; Bypass has none either.
    expect(await hookFor({ permission: 'auto' })('Bash', { command: 'x', dangerouslyDisableSandbox: true })).toBeUndefined();
    expect(await hookFor({ permission: 'bypass', confineShell: true })('Bash', { command: 'x', dangerouslyDisableSandbox: true })).toBeUndefined();
  });

  it('offers to allow every command outside the sandbox for the session, and then stops asking', async () => {
    let hook: any;
    let canUseTool: any;
    const runQuery = ((args: any) => {
      hook = args.options.hooks.PreToolUse[0].hooks[0];
      canUseTool = args.options.canUseTool;
      return Object.assign((async function* () { yield done; })(), { interrupt: async () => undefined });
    }) as any;
    const events: AgentEvent[] = [];
    const handle = claudeAdapter(runQuery).start({ ...options, permission: 'auto', confineShell: true }, 'x', (e) => events.push(e));
    const outside = { command: 'terraform plan', dangerouslyDisableSandbox: true };
    const verdict = async (input: Record<string, unknown>) => (await hook({ tool_name: 'Bash', tool_input: input }))?.hookSpecificOutput?.permissionDecision;
    expect(await verdict(outside)).toBe('ask');
    const pending = canUseTool('Bash', outside, { signal: new AbortController().signal, toolUseID: 'b1' });
    const request = (events.find((e) => e.type === 'needs-input') as { request: InputRequest }).request;
    expect(request.options).toEqual([
      { id: 'allow', label: 'Allow', role: 'allow' },
      { id: 'allow-outside', label: 'Allow all outside the sandbox', role: 'allow' },
      { id: 'deny', label: 'Deny', role: 'deny' },
    ]);
    handle.answer('b1', { optionId: 'allow-outside' });
    expect(await pending).toMatchObject({ behavior: 'allow' });
    // From now on a command that leaves the sandbox runs without a card; one inside it is as before.
    expect(await verdict({ command: 'terraform apply', dangerouslyDisableSandbox: true })).toBe('allow');
    expect(await verdict({ command: 'ls' })).toBeUndefined();
  });

  it('tells Kestrel the choice so it is kept, and a session started with it does not ask at all', async () => {
    let hook: any;
    let canUseTool: any;
    const runQuery = ((args: any) => {
      hook = args.options.hooks.PreToolUse[0].hooks[0];
      canUseTool = args.options.canUseTool;
      return Object.assign((async function* () { yield done; })(), { interrupt: async () => undefined });
    }) as any;
    const outside = { command: 'terraform plan', dangerouslyDisableSandbox: true };
    const verdict = async (input: Record<string, unknown>) => (await hook({ tool_name: 'Bash', tool_input: input }))?.hookSpecificOutput?.permissionDecision;
    const events: AgentEvent[] = [];
    const handle = claudeAdapter(runQuery).start({ ...options, permission: 'auto', confineShell: true }, 'x', (e) => events.push(e));
    await verdict(outside);
    const pending = canUseTool('Bash', outside, { signal: new AbortController().signal, toolUseID: 'b1' });
    handle.answer('b1', { optionId: 'allow-outside' });
    await pending;
    expect(events.filter((e) => e.type === 'outside-allowed')).toHaveLength(1);
    // After a restart Kestrel starts the session with the choice it kept.
    claudeAdapter(runQuery).resume('sid', { ...options, permission: 'auto', confineShell: true, outsideAllowed: true }, () => undefined).send('y');
    expect(await verdict(outside)).toBe('allow');
    expect(await verdict({ command: 'ls' })).toBeUndefined();
  });

  it('keeps asking when one command outside the sandbox is allowed by itself', async () => {
    let hook: any;
    let canUseTool: any;
    const runQuery = ((args: any) => {
      hook = args.options.hooks.PreToolUse[0].hooks[0];
      canUseTool = args.options.canUseTool;
      return Object.assign((async function* () { yield done; })(), { interrupt: async () => undefined });
    }) as any;
    const handle = claudeAdapter(runQuery).start({ ...options, permission: 'auto', confineShell: true }, 'x', () => undefined);
    const outside = { command: 'terraform plan', dangerouslyDisableSandbox: true };
    const pending = canUseTool('Bash', outside, { signal: new AbortController().signal, toolUseID: 'b1' });
    handle.answer('b1', { optionId: 'allow' });
    expect(await pending).toMatchObject({ behavior: 'allow' });
    expect((await hook({ tool_name: 'Bash', tool_input: outside }))?.hookSpecificOutput?.permissionDecision).toBe('ask');
  });

  it('read-only sessions may not read outside the registered projects', async () => {
    const verdict = hookFor({ permission: 'readonly' as const, readableDirectories: ['/p'] });
    expect(await verdict('Read', { file_path: '/etc/hosts' })).toBe('deny');
    expect(await verdict('Read', { file_path: '/p/a' })).toBeUndefined();
  });
});

describe('an approval for an edit outside the session folder', () => {
  it('names the full path and says it is outside the folder', async () => {
    let canUseTool: any;
    const runQuery = ((args: any) => {
      canUseTool = args.options.canUseTool;
      return Object.assign((async function* () { yield done; })(), { interrupt: async () => undefined });
    }) as any;
    const events: AgentEvent[] = [];
    const work = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-outside-')));
    claudeAdapter(runQuery).start({ ...options, directory: work }, 'x', (e) => events.push(e));
    void canUseTool('Write', { file_path: '../memory/notes.md', content: 'hello' }, { signal: new AbortController().signal, toolUseID: 'w1' });
    void canUseTool('Write', { file_path: 'inside.md', content: 'hi' }, { signal: new AbortController().signal, toolUseID: 'w2' });
    const [outside, inside] = events.filter((e) => e.type === 'needs-input').map((e) => (e as { request: InputRequest }).request);
    expect(outside).toMatchObject({ title: `Write ${join(work, '..', 'memory', 'notes.md')}`, detail: "Outside this session's folder.\n\nhello" });
    expect(inside).toMatchObject({ title: 'Write inside.md', detail: 'hi' });
  });
});

describe('fork', () => {
  it('copies the conversation with the SDK’s forkSession, looked up where it was held, and returns the new id', async () => {
    const asked: unknown[] = [];
    const runFork = (async (id: string, opts: unknown) => {
      asked.push([id, opts]);
      return { sessionId: 'forked-1' };
    }) as any;
    const id = await claudeAdapter(scripted().runQuery, runFork).fork!('old-1', { from: '/w/old', to: '/w/new' });
    expect(id).toBe('forked-1');
    expect(asked).toEqual([['old-1', { dir: '/w/old' }]]);
  });

  it('from an earlier turn, copies the transcript through that turn’s last message (upToMessageId)', async () => {
    const asked: unknown[] = [];
    const runFork = (async (id: string, opts: unknown) => {
      asked.push([id, opts]);
      return { sessionId: 'forked-2' };
    }) as any;
    await claudeAdapter(scripted().runQuery, runFork).fork!('old-1', { from: '/w/old', to: '/w/new', at: 'uuid-of-turn-1' });
    expect(asked).toEqual([['old-1', { dir: '/w/old', upToMessageId: 'uuid-of-turn-1' }]]);
  });

  it('resumes the copy by its new id: a turn in the fork runs on the forked conversation', async () => {
    const { runQuery, calls } = scripted([done]);
    const handle = claudeAdapter(runQuery).resume('forked-1', options, () => undefined);
    handle.send('carry on');
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls[0]).toMatchObject({ resume: 'forked-1', cwd: '/w' });
  });

  it('passes the SDK’s refusal on as the reason', async () => {
    const runFork = (async () => {
      throw new Error('Session old-1 not found');
    }) as any;
    await expect(claudeAdapter(scripted().runQuery, runFork).fork!('old-1', { from: '/w/old', to: '/w/new' })).rejects.toThrow('Session old-1 not found');
  });
});
