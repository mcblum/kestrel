import { describe, expect, it } from 'vitest';
import type { ModelOption } from '../agents/types.ts';
import { defaultName, effortLabel, family, fitToModel, modelLabel, modelMenu, pickFromMenu, shownEffort, splitModels } from './model-choice.ts';

const ALL = ['low', 'medium', 'high', 'xhigh', 'max'];
// Shaped like what Claude's SDK 0.3.322 returned (agents/claude/models.ts maps it).
const MODELS: ModelOption[] = [
  { id: '', label: 'Default', efforts: ALL, fast: true, resolves: 'claude-opus-5-5' },
  { id: 'opus', label: 'Opus 5.5', efforts: ALL, fast: true, resolves: 'claude-opus-5-5' },
  { id: 'fable', label: 'Fable 5.2', efforts: ALL, fast: true, resolves: 'claude-fable-5-2' },
  { id: 'sonnet', label: 'Sonnet 5.5', efforts: ALL, resolves: 'claude-sonnet-5-5' },
  { id: 'haiku', label: 'Haiku 5.5', efforts: ALL, resolves: 'claude-haiku-5-5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', efforts: ALL, resolves: 'claude-fable-5-1' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', resolves: 'claude-haiku-4-5' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ALL, fast: true, resolves: 'claude-opus-5-5' },
];

describe('splitModels', () => {
  it('lists the newest of each family first and the rest under More models', () => {
    const { current, more } = splitModels(MODELS);
    expect(current.map((m) => m.label)).toEqual(['Opus 5.5', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5']);
    expect(more.map((m) => m.label)).toEqual(['Fable 5.1', 'Haiku 4.5']);
  });

  it('lists a model once when an alias and its full id both appear, and never the Default entry', () => {
    const ids = Object.values(splitModels(MODELS)).flat().map((m) => m.id);
    expect(ids).not.toContain('');
    expect(ids).not.toContain('claude-opus-5-5');
  });

  it('names a family without its version or a bracketed note, so Codex lines are families of their own', () => {
    expect(['Opus 5.5', 'Opus 4.6 (1M context)', 'GPT-6.1-Sol', 'GPT-5.6-Sol', 'GPT-6.1 Terra', 'GPT-6-Astra', 'Default'].map(family)).toEqual(['opus', 'opus', 'gpt sol', 'gpt sol', 'gpt terra', 'gpt astra', 'default']);
  });

  it('keeps models with no version in their name as current, the default among them (the fallback list)', () => {
    expect(splitModels([{ id: '', label: 'Default' }, { id: 'opus', label: 'Opus' }, { id: 'haiku', label: 'Haiku' }]).current.map((m) => m.id)).toEqual(['', 'opus', 'haiku']);
  });

  // Codex's list as model/list gave it on 2026-11-19, with gpt-6-astra in the user's Codex config.
  it('counts the row the Default stands for as the default: the current one of its line, never under More models', () => {
    const row = (id: string, label: string): ModelOption => ({ id, label, resolves: id });
    const codex = [
      { id: '', label: 'Default', resolves: 'gpt-6-astra' },
      row('gpt-6.2-sol', 'GPT-6.2-Sol'),
      row('gpt-6.2-astra', 'GPT-6.2-Astra'),
      row('gpt-6.1-terra', 'GPT-6.1 Terra'),
      row('gpt-6-astra', 'GPT-6-Astra'),
      row('gpt-6-luna', 'GPT-6-Luna'),
    ];
    const { current, more } = splitModels(codex);
    expect(current.map((m) => m.id)).toEqual(['gpt-6.2-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-6-luna']);
    expect(more.map((m) => m.id)).toEqual(['gpt-6.2-astra']);
  });
});

// A provider where the aliases do not point at the account's default: on Bedrock the default was
// Opus 5.5 while "opus" meant Opus 5, which the account had not enabled. The default was missing
// from the menu, so the only Opus on offer was the one that failed (0.0.3).
describe('a default that no other row stands for', () => {
  const BEDROCK: ModelOption[] = [
    { id: '', label: 'Default', description: 'Use the default model', efforts: ALL, resolves: 'us.anthropic.claude-opus-5-5-20260815-v1:0' },
    { id: 'opus', label: 'Opus 5', efforts: ALL, resolves: 'us.anthropic.claude-opus-5-20260210-v1:0' },
    { id: 'sonnet', label: 'Sonnet 5.5', efforts: ALL, resolves: 'us.anthropic.claude-sonnet-5-5-20260815-v1:0' },
  ];

  it('is a row of its own, first, named for the model it stands for', () => {
    const { current, more } = splitModels(BEDROCK);
    expect(current.map((m) => [m.id, m.label])).toEqual([['', 'Opus 5.5'], ['sonnet', 'Sonnet 5.5']]);
    expect(more.map((m) => m.label)).toEqual(['Opus 5']);
  });

  it('is what the row says and what is ticked for a session on the default, and can be picked again', () => {
    expect(modelLabel(BEDROCK, '')).toBe('Opus 5.5');
    expect(modelMenu(BEDROCK, { model: '' })[0]).toMatchObject({ id: 'model:', label: 'Opus 5.5', checked: true });
    expect(pickFromMenu(BEDROCK, { model: 'opus', effort: 'high' }, 'model:')).toEqual({ model: '', effort: 'high', fast: false });
    expect(shownEffort(BEDROCK, { model: '', effort: 'high' })).toBe('High');
  });

  it('is never pushed under More models by an alias that looks newer', () => {
    const odd: ModelOption[] = [{ id: '', label: 'Default', resolves: 'arn:claude-opus-5-20260210' }, { id: 'opus', label: 'Opus 5.5', resolves: 'claude-opus-5-5' }];
    expect(splitModels(odd).current.map((m) => m.id)).toEqual(['']);
  });

  it('names the default from its description, from the id it resolves to, or says Default', () => {
    expect(defaultName({ id: '', label: 'Default', description: 'Opus 5.5 · Best for everyday, complex tasks' })).toBe('Opus 5.5');
    expect(defaultName({ id: '', label: 'Default', resolves: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' })).toBe('Haiku 4.5');
    expect(defaultName({ id: '', label: 'Default', resolves: 'claude-sonnet-5' })).toBe('Sonnet 5');
    expect(defaultName({ id: '', label: 'Default', resolves: 'gpt-6.1-sol' })).toBe('Default');
    expect(defaultName({ id: '', label: 'Default' })).toBe('Default');
  });
});

describe('labels', () => {
  it('shows the default as the model it resolves to', () => {
    expect(modelLabel(MODELS, '')).toBe('Opus 5.5');
    expect(modelLabel(MODELS, 'claude-fable-5-1')).toBe('Fable 5.1');
    expect(modelLabel([], '')).toBe('Default');
    expect(modelLabel([], 'some-old-id')).toBe('some-old-id');
  });

  it('names effort levels in words', () => {
    expect(effortLabel('xhigh')).toBe('Extra high');
    expect(effortLabel('medium')).toBe('Medium');
    expect(effortLabel('turbo')).toBe('Turbo');
  });
});

describe('fitToModel', () => {
  it('drops an effort and fast mode the model cannot take', () => {
    expect(fitToModel(MODELS, { model: 'claude-haiku-4-5', effort: 'high', fast: true })).toEqual({ model: 'claude-haiku-4-5', effort: '', fast: false });
    expect(fitToModel(MODELS, { model: 'sonnet', effort: 'high', fast: true })).toEqual({ model: 'sonnet', effort: 'high', fast: false });
    expect(fitToModel(MODELS, { model: 'opus', effort: 'max', fast: true })).toEqual({ model: 'opus', effort: 'max', fast: true });
  });

  it('keeps everything while the model is unknown', () => {
    const s = { model: 'opus', effort: 'max', fast: true };
    expect(fitToModel([], s)).toBe(s);
  });

  it('shows no effort for a model without effort, or on the default effort', () => {
    expect(shownEffort(MODELS, { model: 'claude-haiku-4-5', effort: 'high' })).toBeNull();
    expect(shownEffort(MODELS, { model: 'opus', effort: '' })).toBeNull();
    expect(shownEffort(MODELS, { model: 'opus', effort: 'medium' })).toBe('Medium');
  });
});

describe('modelMenu', () => {
  it('numbers the current models and ticks the chosen one (the default counts as what it resolves to)', () => {
    const items = modelMenu(MODELS, { model: '', effort: 'medium' });
    expect(items.slice(0, 4).map((i) => [i.label, i.shortcut, i.checked])).toEqual([
      ['Opus 5.5', '1', true],
      ['Fable 5.2', '2', false],
      ['Sonnet 5.5', '3', false],
      ['Haiku 5.5', '4', false],
    ]);
  });

  it('has Effort and More models submenus, then the fast-mode switch', () => {
    const items = modelMenu(MODELS, { model: 'fable', effort: 'medium', fast: true });
    const effort = items.find((i) => i.id === 'effort')!;
    expect(effort.value).toBe('Medium');
    expect(effort.separatorBefore).toBe(true);
    expect(effort.children!.map((c) => [c.label, c.checked])).toEqual([['Default', false], ['Low', false], ['Medium', true], ['High', false], ['Extra high', false], ['Max', false]]);
    expect(items.find((i) => i.id === 'more-models')!.children!.map((c) => c.label)).toEqual(['Fable 5.1', 'Haiku 4.5']);
    const fast = items.at(-1)!;
    expect(fast).toMatchObject({ id: 'fast', toggle: true, checked: true, heading: 'Fast mode' });
  });

  it('offers no effort and no fast mode for a model without them', () => {
    const items = modelMenu(MODELS, { model: 'claude-haiku-4-5' });
    expect(items.some((i) => i.id === 'effort' || i.id === 'fast')).toBe(false);
    expect(items.find((i) => i.id === 'more-models')!.children!.find((c) => c.checked)?.label).toBe('Haiku 4.5');
  });
});

it('offers the default alone when the agent names no other model', () => {
  expect(modelMenu([{ id: '', label: 'Default' }], { model: '' }).map((i) => [i.label, i.checked])).toEqual([['Default', true]]);
});

describe('pickFromMenu', () => {
  it('applies a model, an effort or the fast switch', () => {
    const s = { model: 'opus', effort: 'high', fast: true };
    expect(pickFromMenu(MODELS, s, 'model:sonnet')).toEqual({ model: 'sonnet', effort: 'high', fast: false });
    expect(pickFromMenu(MODELS, s, 'effort:low')).toEqual({ ...s, effort: 'low' });
    expect(pickFromMenu(MODELS, s, 'effort:')).toEqual({ ...s, effort: '' });
    expect(pickFromMenu(MODELS, s, 'fast')).toEqual({ ...s, fast: false });
    expect(pickFromMenu(MODELS, s, 'more-models')).toBe(s);
  });
});
