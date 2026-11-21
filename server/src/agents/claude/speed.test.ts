// Effort, fast mode, the model list and context usage, as the Claude adapter hands them to the SDK.
import { describe, expect, it } from 'vitest';
import { NO_TOOLS } from '../test-support.ts';
import type { AgentEvent } from '../types.ts';
import { askContextUsage, claudeContextUsage, toContextUsage } from './context.ts';
import { claudeAdapter } from './index.ts';
import { toOptions } from './models.ts';
import { baseOptions, speedOptions } from './options.ts';
import { speedFields } from '../../controls-api.ts';

const opts = { directory: '/w', permission: 'ask' as const, instruction: 'x', tools: NO_TOOLS };
const SDK_USAGE = {
  model: 'claude-haiku-5-5', totalTokens: 15538, maxTokens: 1_000_000, rawMaxTokens: 1_000_000, percentage: 2,
  categories: [
    { id: 'messages', name: 'Messages', tokens: 5106, color: 'x', kind: 'used' },
    { id: 'autocompact_buffer', name: 'Autocompact buffer', tokens: 33000, color: 'x', kind: 'buffer' },
    { id: 'system_tools_deferred', name: 'System tools (deferred)', tokens: 14968, color: 'x', kind: 'deferred' },
    { id: 'free_space', name: 'Free space', tokens: 951462, color: 'x', kind: 'free' },
  ],
} as any;

describe('speedOptions', () => {
  it('sends a known effort as the effort option and fast mode as the fastMode setting', () => {
    expect(speedOptions({ effort: 'xhigh', fast: true })).toEqual({ effort: 'xhigh', settings: { fastMode: true } });
    expect(speedOptions({ fast: false })).toEqual({ settings: { fastMode: false } });
    expect(speedOptions({ effort: 'turbo' })).toEqual({});
    expect(speedOptions({})).toEqual({});
  });

  it('is part of the session options', () => {
    expect(baseOptions({ ...opts, model: 'opus', effort: 'low', fast: true })).toMatchObject({ model: 'opus', effort: 'low', settings: { fastMode: true } });
  });
});

describe('toOptions', () => {
  it('keeps effort levels, fast mode and the resolved id from the SDK, and the Default entry first', () => {
    const models = toOptions([
      { value: 'default', displayName: 'Default (recommended)', description: 'Opus 5.5', resolvedModel: 'claude-opus-5-5', supportsEffort: true, supportedEffortLevels: ['low', 'high'], supportsFastMode: true },
      { value: 'haiku', displayName: 'Haiku 5.5', resolvedModel: 'claude-haiku-5-5', supportsEffort: true, supportedEffortLevels: ['low'] },
      { value: 'claude-haiku-4-5', displayName: 'Haiku 4.5' },
    ]);
    expect(models).toEqual([
      { id: '', label: 'Default', description: 'Opus 5.5', efforts: ['low', 'high'], fast: true, resolves: 'claude-opus-5-5' },
      { id: 'haiku', label: 'Haiku 5.5', efforts: ['low'], resolves: 'claude-haiku-5-5' },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
    ]);
  });
});

describe('context usage', () => {
  it('reads the SDK report as Kestrel rows', () => {
    const usage = toContextUsage(SDK_USAGE, 7);
    expect(usage).toMatchObject({ model: 'claude-haiku-5-5', usedTokens: 15538, windowTokens: 1_000_000, at: 7 });
    expect(usage.rows.map((r) => r.kind)).toEqual(['used', 'buffer', 'deferred', 'free']);
  });

  it('is null when the query cannot say, or does not answer in time', async () => {
    expect(await askContextUsage(null)).toBeNull();
    expect(await askContextUsage({ getContextUsage: () => Promise.reject(new Error('closed')) } as any)).toBeNull();
    expect(await askContextUsage({ getContextUsage: () => new Promise(() => undefined) } as any, 1)).toBeNull();
  });

  it('is measured as a turn ends, before the turn is reported done', async () => {
    const result = { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0 };
    const runQuery = (() => Object.assign((async function* () { yield result; })(), { interrupt: async () => undefined, getContextUsage: async () => SDK_USAGE })) as any;
    const events: AgentEvent[] = [];
    await new Promise<void>((resolve) => claudeAdapter(runQuery).start(opts, 'hi', (e) => (events.push(e), e.type === 'done' && resolve())));
    expect(events.map((e) => e.type)).toEqual(['context', 'done']);
  });

  it('for an idle session, resumes without a prompt, MCP servers or hooks, and closes the query', async () => {
    let seen: any;
    let closed = false;
    const runQuery = ((args: any) => ((seen = args.options), { getContextUsage: async () => SDK_USAGE, close: () => void (closed = true) })) as any;
    const usage = await claudeContextUsage('sess-1', { ...opts, fast: true }, runQuery);
    expect(usage?.usedTokens).toBe(15538);
    expect(seen).toMatchObject({ resume: 'sess-1', mcpServers: {}, settings: { fastMode: true, disableAllHooks: true } });
    expect(closed).toBe(true);
  });
});

describe('speedFields', () => {
  it('reads effort and fast from a request body and refuses bad values', () => {
    expect(speedFields({ effort: 'high', fast: true })).toEqual({ effort: 'high', fast: true });
    expect(speedFields({ effort: '' })).toEqual({ effort: '' });
    expect(speedFields({})).toEqual({});
    expect(() => speedFields({ effort: 'HIGH; rm' })).toThrow(/effort/);
    expect(() => speedFields({ fast: 'yes' })).toThrow(/fast/);
  });
});
