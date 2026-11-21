// What Codex offers the controls under the message box, from recorded app-server traffic
// (fixtures/*.jsonl, codex-cli 0.167.2): models with their effort levels and fast tier, the
// permission levels, and the context window after a turn. Pure, fixture-fed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { modelMenu, splitModels } from '../../shared/model-choice.ts';
import { PERMISSION_LEVELS } from '../../shared/permissions.ts';
import { toContextUsage } from './context.ts';
import { speedParams } from './handle.ts';
import { configuredModel, fastTiers, STANDARD_TIER, toOptions } from './models.ts';
import { CODEX_LEVELS, codexPolicy } from './policy.ts';

type Msg = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> };
const recorded = (name: string): Msg[] =>
  readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { msg: Msg }).msg);

/** The `data` of the recorded `model/list` answer. */
function listedModels(): unknown[] {
  const messages = recorded('account.jsonl');
  const ask = messages.find((m) => m.method === 'model/list')!;
  return messages.find((m) => m.id === ask.id && m.result)!.result!.data as unknown[];
}

const ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

describe('Codex models as capabilities', () => {
  const options = toOptions(listedModels());

  it('give each model the effort levels Codex lists for it, in its order', () => {
    expect(options.find((m) => m.id === 'gpt-6.1-sol')!.efforts).toEqual(ALL_EFFORTS);
    expect(options.find((m) => m.id === 'gpt-6-luna')!.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('offer fast mode only for a model with a Fast service tier', () => {
    expect(options.filter((m) => m.id !== '').every((m) => m.fast === true)).toBe(true);
    const plain = toOptions([{ id: 'x', displayName: 'X 1', serviceTiers: [], supportedReasoningEfforts: [] }]);
    expect(plain[1]).toEqual({ id: 'x', label: 'X 1', resolves: 'x' });
    expect(fastTiers(listedModels())).toMatchObject({ '': 'priority', 'gpt-6.1-sol': 'priority' });
  });

  it('make Default stand for the catalogue default, or the model in the Codex config', () => {
    expect(options[0]).toMatchObject({ id: '', label: 'Default', resolves: 'gpt-6.1-sol', efforts: ALL_EFFORTS, fast: true });
    expect(toOptions(listedModels(), 'gpt-6-luna')[0]).toMatchObject({ resolves: 'gpt-6-luna', efforts: ALL_EFFORTS.slice(0, 5) });
    // A configured model Codex does not list: Default is not taken to be some other model.
    expect(toOptions(listedModels(), 'my-own-model')[0]).toEqual({ id: '', label: 'Default', description: 'The model set in your Codex config, else GPT-6.1-Sol' });
    expect(configuredModel({ config: { model: 'gpt-6-luna' } })).toBe('gpt-6-luna');
    expect(configuredModel({ config: { model: null } })).toBeNull();
  });

  it('list the newest of each line (Sol, Astra, Terra, Luna) first and the older ones under More models', () => {
    const { current, more } = splitModels(options);
    expect(current.map((m) => m.label)).toEqual(['GPT-6.1-Sol', 'GPT-6-Astra', 'GPT-6.1 Terra', 'GPT-6-Luna']);
    expect(more.map((m) => m.label)).toEqual(['GPT-6-Sol', 'GPT-5.6-Sol', 'GPT-5.6-Terra', 'GPT-5.6-Luna']);
  });

  it('build a model menu with Codex effort levels and fast mode, the default shown as its model', () => {
    const items = modelMenu(options, { model: '', effort: 'ultra' });
    expect(items.slice(0, 4).map((i) => [i.label, i.checked])).toEqual([
      ['GPT-6.1-Sol', true],
      ['GPT-6-Astra', false],
      ['GPT-6.1 Terra', false],
      ['GPT-6-Luna', false],
    ]);
    expect(items.find((i) => i.id === 'effort')!.children!.map((c) => c.label)).toEqual(['Default', 'Low', 'Medium', 'High', 'Extra high', 'Max', 'Ultra']);
    expect(items.some((i) => i.id === 'fast')).toBe(true);
  });
});

describe('Codex effort and fast mode on a turn', () => {
  it('send the effort and the fast tier, "default" when fast mode is off, nothing when unset', () => {
    expect(speedParams({ effort: 'high', fast: true }, 'priority')).toEqual({ effort: 'high', serviceTierForTurn: 'priority' });
    expect(speedParams({ fast: false }, null)).toEqual({ serviceTierForTurn: STANDARD_TIER });
    expect(speedParams({}, null)).toEqual({});
    expect(speedParams({ effort: '', fast: true }, null)).toEqual({});
  });
});

describe('Codex permission levels', () => {
  it('are every level Kestrel has, each with a policy', () => {
    expect([...CODEX_LEVELS].sort()).toEqual(PERMISSION_LEVELS.map((l) => l.id).sort());
    for (const level of CODEX_LEVELS) expect(codexPolicy(level)).toBeTruthy();
  });

  it('let writes outside the folder follow the mode: asked in Manual and Accept edits, let through by Kestrel in Auto and Bypass, none in Plan and Read only', () => {
    const outside = (level: (typeof CODEX_LEVELS)[number]) => {
      const p = codexPolicy(level);
      if (p.sandbox === 'read-only') return 'none';
      return p.acceptEdits === 'anywhere' ? 'kestrel' : 'card';
    };
    expect(Object.fromEntries(CODEX_LEVELS.map((l) => [l, outside(l)]))).toEqual({ auto: 'kestrel', ask: 'card', edits: 'card', plan: 'none', bypass: 'kestrel', readonly: 'none' });
  });

  it("send every approval to Kestrel, never to Codex's own reviewer, so the edit rule sees what Codex asks about", () => {
    for (const level of CODEX_LEVELS) expect(codexPolicy(level).approvalsReviewer).toBe('user');
    // Bypass has Codex ask about every file change (and Kestrel accepts what the rule lets through).
    expect(codexPolicy('bypass').approvalPolicy).toBe('untrusted');
  });
});

describe('Codex context usage', () => {
  it('maps the last thread/tokenUsage/updated of a recorded turn to used and free', () => {
    const updates = recorded('mcp.jsonl').filter((m) => m.method === 'thread/tokenUsage/updated');
    const last = updates.at(-1)!.params!.tokenUsage as { last: { totalTokens: number }; modelContextWindow: number };
    const usage = toContextUsage(last, 'gpt-6.1-sol', 1)!;
    expect(usage).toMatchObject({ model: 'gpt-6.1-sol', usedTokens: last.last.totalTokens, windowTokens: last.modelContextWindow, at: 1 });
    expect(usage.rows).toEqual([
      { name: 'Conversation', tokens: last.last.totalTokens, kind: 'used' },
      { name: 'Free space', tokens: last.modelContextWindow - last.last.totalTokens, kind: 'free' },
    ]);
  });

  it('is nothing without a window to measure against', () => {
    expect(toContextUsage({ last: { totalTokens: 5 }, modelContextWindow: null }, 'm')).toBeNull();
    expect(toContextUsage(null, 'm')).toBeNull();
  });
});
