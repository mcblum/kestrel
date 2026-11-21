import { describe, expect, it } from 'vitest';
import { defaultName, modelLabel, splitModels } from '../../shared/model-choice.ts';
import { modelIn } from './configured-model.ts';
import { toOptions } from './models.ts';

describe('modelIn', () => {
  it('reads the model from settings, the model key before the env block', () => {
    expect(modelIn({ model: 'us.anthropic.claude-opus-5-5-20260815-v1:0' })).toBe('us.anthropic.claude-opus-5-5-20260815-v1:0');
    expect(modelIn({ env: { ANTHROPIC_MODEL: 'claude-sonnet-5-5' } })).toBe('claude-sonnet-5-5');
    expect(modelIn({ model: 'opus', env: { ANTHROPIC_MODEL: 'sonnet' } })).toBe('opus');
  });

  it('is null when nothing usable is set', () => {
    for (const settings of [null, 'x', {}, { model: '' }, { model: 5 }, { env: { ANTHROPIC_MODEL: '  ' } }, { env: 'x' }]) expect(modelIn(settings)).toBeNull();
  });
});

// What a Bedrock setup looked like in 0.0.4: the SDK's list called its default and its "opus"
// alias Opus 5 (not enabled on the account), while the user's settings ran Opus 5.5.
const SDK = [
  { value: 'default', displayName: 'Default (recommended)', description: 'Opus 5 · Best for everyday, complex tasks', resolvedModel: 'us.anthropic.claude-opus-5-20260210-v1:0', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
  { value: 'opus', displayName: 'Opus 5', resolvedModel: 'us.anthropic.claude-opus-5-20260210-v1:0', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
  { value: 'sonnet', displayName: 'Sonnet 5.5', resolvedModel: 'us.anthropic.claude-sonnet-5-5-20260815-v1:0' },
];

describe('toOptions with the model the settings name', () => {
  it('without one, the default is whatever row the SDK says it is', () => {
    const { current } = splitModels(toOptions(SDK));
    expect(current.map((m) => m.label)).toEqual(['Opus 5', 'Sonnet 5.5']);
  });

  it('names the default for the settings model and lists it first, beside the alias that is not it', () => {
    const options = toOptions(SDK, 'us.anthropic.claude-opus-5-5-20260815-v1:0');
    const { current, more } = splitModels(options);
    expect(current.map((m) => [m.id, m.label])).toEqual([['', 'Opus 5.5'], ['sonnet', 'Sonnet 5.5']]);
    expect(more.map((m) => [m.id, m.label])).toEqual([['opus', 'Opus 5']]);
    expect(modelLabel(options, '')).toBe('Opus 5.5');
    // The effort levels the SDK gave for its default still apply.
    expect(options[0]!.efforts).toEqual(['low', 'high']);
  });

  it('is the listed row when the settings name an alias, with or without a window note', () => {
    for (const configured of ['sonnet', 'sonnet[1m]']) {
      const options = toOptions(SDK, configured);
      expect(splitModels(options).current.map((m) => m.id)).toEqual(['opus', 'sonnet']);
      expect(modelLabel(options, '')).toBe('Sonnet 5.5');
    }
  });

  it('says Default when the settings model has no name it can read', () => {
    const options = toOptions(SDK, 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123');
    expect(defaultName(options[0]!)).toBe('Default');
    expect(splitModels(options).current[0]).toMatchObject({ id: '', label: 'Default' });
  });
});

// What SDK 0.3.322 really reports with CLAUDE_CODE_USE_BEDROCK=1 (recorded 2026-11-16, trimmed):
// the newest of each line has no version in its name.
const BEDROCK = [
  { value: 'default', displayName: 'Default', resolvedModel: 'us.anthropic.claude-opus-5-5', description: 'Use the default model (currently Opus 5.5)' },
  { value: 'us.anthropic.claude-fable-5-2', displayName: 'Fable', resolvedModel: 'us.anthropic.claude-fable-5-2', description: 'Fable 5.2 · Most capable for your hardest and longest-running tasks' },
  { value: 'us.anthropic.claude-sonnet-5-5', displayName: 'Sonnet', resolvedModel: 'us.anthropic.claude-sonnet-5-5', description: 'Sonnet 5.5 · Efficient for routine tasks' },
  { value: 'us.anthropic.claude-sonnet-5', displayName: 'Sonnet 5', resolvedModel: 'us.anthropic.claude-sonnet-5', description: 'Sonnet 5 · Previous Sonnet version' },
  { value: 'us.anthropic.claude-sonnet-4-6[1m]', displayName: 'Sonnet 4.6 (1M context)', resolvedModel: 'us.anthropic.claude-sonnet-4-6[1m]', description: 'Sonnet 4.6 for long sessions' },
  { value: 'us.anthropic.claude-opus-5-5', displayName: 'Opus', resolvedModel: 'us.anthropic.claude-opus-5-5', description: 'Opus 5.5 · Best for everyday, complex tasks' },
  { value: 'us.anthropic.claude-opus-5', displayName: 'Opus 5', resolvedModel: 'us.anthropic.claude-opus-5', description: 'Opus 5 · Previous Opus version' },
  { value: 'us.anthropic.claude-opus-4-1-20250805-v1:0', displayName: 'Opus 4.1', resolvedModel: 'us.anthropic.claude-opus-4-1-20250805-v1:0', description: 'Opus 4.1 · Legacy' },
  { value: 'haiku', displayName: 'Haiku', resolvedModel: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', description: 'Haiku 4.5 · Fastest for quick answers' },
];

describe('a Bedrock model list', () => {
  it('names every model with its version', () => {
    expect(toOptions(BEDROCK).slice(1).map((m) => m.label)).toEqual(['Fable 5.2', 'Sonnet 5.5', 'Sonnet 5', 'Sonnet 4.6 (1M context)', 'Opus 5.5', 'Opus 5', 'Opus 4.1', 'Haiku 4.5']);
  });

  it('lists the newest of each line first, Opus 5.5 among them and ticked for the default', () => {
    const options = toOptions(BEDROCK);
    const { current, more } = splitModels(options);
    expect(current.map((m) => m.label)).toEqual(['Fable 5.2', 'Sonnet 5.5', 'Opus 5.5', 'Haiku 4.5']);
    expect(more.map((m) => m.label)).toEqual(['Sonnet 5', 'Sonnet 4.6 (1M context)', 'Opus 5', 'Opus 4.1']);
    expect(modelLabel(options, '')).toBe('Opus 5.5');
  });

  it('reads a version from the model id when the description has none', () => {
    expect(toOptions([{ value: 'us.anthropic.claude-opus-5-5', displayName: 'Opus', resolvedModel: 'us.anthropic.claude-opus-5-5' }])[1]!.label).toBe('Opus 5.5');
    expect(toOptions([{ value: 'x', displayName: 'Opus', resolvedModel: 'something-else' }])[1]!.label).toBe('Opus');
  });

  it('names a lone default from "(currently …)"', () => {
    expect(defaultName({ id: '', label: 'Default', description: 'Use the default model (currently Opus 5.5)' })).toBe('Opus 5.5');
  });
});
