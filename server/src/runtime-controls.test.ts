// Effort, fast mode, capabilities and context usage through the runtime.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentHandle, StartOptions } from './agents/types.ts';
import type { ContextUsage } from './shared/context-usage.ts';
import type { LivePatch } from './model.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { SessionRuntime } from './runtime.ts';
import { Workspace } from './workspace.ts';

const USAGE: ContextUsage = { model: 'm', usedTokens: 1500, windowTokens: 200_000, rows: [{ name: 'Messages', tokens: 1500, kind: 'used' }], at: 1 };

function agent(measure?: ContextUsage) {
  const starts: StartOptions[] = [];
  const resumes: StartOptions[] = [];
  const asked: string[] = [];
  const handle = (emit: (e: AgentEvent) => void): AgentHandle => ({
    agentSessionId: () => 'agent-1',
    busy: () => false,
    send: () => {
      if (measure) emit({ type: 'context', usage: measure });
      emit({ type: 'done', reason: 'complete' });
    },
    answer: () => undefined,
    stop: async () => undefined,
  });
  const adapter: AgentAdapter = {
    agent: 'claude',
    models: async () => ({ models: [{ id: 'opus', label: 'Opus 5.5', efforts: ['low', 'high'], fast: true }], fromSdk: true }),
    start: (options, _prompt, emit) => {
      starts.push(options);
      emit({ type: 'started', agentSessionId: 'agent-1', model: 'fake', kestrelTools: 'connected' });
      const h = handle(emit);
      h.send('');
      return h;
    },
    resume: (_id, options, emit) => (resumes.push(options), handle(emit)),
    contextUsage: async (id) => (asked.push(id), { ...USAGE, usedTokens: 42 }),
  };
  return { adapter, starts, resumes, asked };
}

function setup(adapter: AgentAdapter) {
  const workspace = new Workspace(memoryPersistence());
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-ctl-')));
  const runtime = new SessionRuntime(workspace, { claude: adapter }, data);
  const patches: LivePatch[] = [];
  runtime.onLive((_id, patch) => patches.push(patch));
  return { workspace, runtime, patches };
}

describe('effort and fast mode', () => {
  it('start with them, change from the next message, and are stored with the session', async () => {
    const a = agent();
    const { workspace, runtime } = setup(a.adapter);
    const session = await runtime.start({ agent: 'claude', projectId: null, prompt: 'x', model: 'opus', effort: 'high', fast: true });
    await runtime.idle(session.id);
    expect(a.starts[0]).toMatchObject({ model: 'opus', effort: 'high', fast: true });

    await runtime.reply(session.id, 'again', { effort: 'low', fast: false });
    await runtime.idle(session.id);
    expect(a.resumes[0]).toMatchObject({ model: 'opus', effort: 'low', fast: false });
    expect((await workspace.detail(session.id))!.settings).toMatchObject({ model: 'opus', effort: 'low', fast: false });
  });

  it('leaves them out when none was chosen', async () => {
    const a = agent();
    const { runtime } = setup(a.adapter);
    await runtime.idle((await runtime.start({ agent: 'claude', projectId: null, prompt: 'x' })).id);
    expect('effort' in a.starts[0]!).toBe(false);
    expect('fast' in a.starts[0]!).toBe(false);
  });
});

describe('capabilities', () => {
  it('says what the agent offers: its models, every permission level unless it names some, and context usage', async () => {
    const { runtime } = setup(agent().adapter);
    const caps = await runtime.capabilities('claude');
    expect(caps.models[0]).toMatchObject({ efforts: ['low', 'high'], fast: true });
    expect(caps.permissions).toContain('auto');
    expect(caps.contextUsage).toBe(true);
    await expect(runtime.capabilities('codex')).rejects.toThrow(/not connected/);
  });
});

describe('context usage', () => {
  it('is measured as a turn ends and sent on the live channel; asking again uses it', async () => {
    const a = agent(USAGE);
    const { runtime, patches } = setup(a.adapter);
    const session = await runtime.start({ agent: 'claude', projectId: null, prompt: 'x' });
    await runtime.idle(session.id);
    expect(patches.some((p) => p.context === USAGE)).toBe(true);
    expect(await runtime.contextUsage(session.id)).toBe(USAGE);
    expect(a.asked).toEqual([]);
  });

  it('is asked of the agent once for a session with nothing measured', async () => {
    const a = agent();
    const { runtime } = setup(a.adapter);
    const session = await runtime.start({ agent: 'claude', projectId: null, prompt: 'x' });
    await runtime.idle(session.id);
    const [one, two] = await Promise.all([runtime.contextUsage(session.id), runtime.contextUsage(session.id)]);
    expect(one?.usedTokens).toBe(42);
    expect(two?.usedTokens).toBe(42);
    expect(a.asked).toEqual(['agent-1']);
    await runtime.contextUsage(session.id);
    expect(a.asked).toHaveLength(1);
  });
});
