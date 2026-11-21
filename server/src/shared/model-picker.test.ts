import { describe, expect, it } from 'vitest';
import type { ModelOption } from '../agents/types.ts';
import { shownModelMenu, switchAgent } from './model-picker.ts';
import { startControls, type Remembered } from './sticky-controls.ts';
import { DEFAULT_CONTROLS, type Controls } from './tabs.ts';

const draft: Controls = { ...DEFAULT_CONTROLS, agent: 'codex', model: 'gpt-6.2-astra', effort: 'high', fast: true, projectId: 'p1' };
const claudeSet = { model: 'sonnet', effort: 'medium', fast: false, permission: 'auto' as const };
// The last session was Codex: Claude's set is still remembered (matt/kestrel#14).
const remembered: Remembered = { agent: 'codex', projectId: null, byAgent: { claude: claudeSet, codex: { model: 'gpt-6-luna', effort: '', fast: false, permission: 'ask' } } };

describe('switching the agent of a draft', () => {
  it('lands on the model, effort, fast mode and mode remembered for that agent, although another was used last', () => {
    expect(switchAgent(draft, 'claude', remembered)).toEqual({ ...draft, agent: 'claude', ...claudeSet });
  });

  it("uses the agent's defaults when nothing is remembered for it", () => {
    expect(switchAgent({ ...draft, agent: 'claude' }, 'codex', { ...remembered, agent: 'claude', byAgent: { claude: claudeSet } })).toEqual({ ...draft, agent: 'codex', model: '', effort: '', fast: false, permission: 'auto' });
  });

  it('draws what a fresh draft on that agent draws', () => {
    const fresh = startControls(remembered);
    const away = switchAgent(fresh, 'claude', remembered);
    expect(switchAgent(away, 'codex', remembered)).toEqual(fresh);
  });

  it('keeps the rest of the draft (project)', () => {
    expect(switchAgent(draft, 'claude', remembered).projectId).toBe(draft.projectId);
  });
});

// Codex as listed with a configured GPT-6-Astra while a newer Astra exists.
const codex: ModelOption[] = [
  { id: '', label: 'Default', resolves: 'gpt-6-astra' },
  { id: 'gpt-6.2-sol', label: 'GPT-6.2-Sol', resolves: 'gpt-6.2-sol' },
  { id: 'gpt-6.2-astra', label: 'GPT-6.2-Astra', resolves: 'gpt-6.2-astra' },
  { id: 'gpt-6-astra', label: 'GPT-6-Astra', resolves: 'gpt-6-astra' },
  { id: 'gpt-6-sol', label: 'GPT-6-Sol', resolves: 'gpt-6-sol' },
];
const ticked = (items: ReturnType<typeof shownModelMenu>) => items.filter((i) => i.checked).map((i) => i.label);

describe('the model menu as drawn', () => {
  it("ticks the default's model on the first level when it is an older one, as the current one of its line", () => {
    const items = shownModelMenu(codex, { model: '' });
    expect(ticked(items)).toEqual(['GPT-6-Astra']);
    expect(items.filter((i) => i.id.startsWith('model:')).map((i) => i.label)).toEqual(['GPT-6.2-Sol', 'GPT-6-Astra']);
    expect(items.find((i) => i.label === 'GPT-6-Astra')!.shortcut).toBe('2');
    expect(items.find((i) => i.id === 'more-models')!.children!.map((c) => c.label)).toEqual(['GPT-6.2-Astra', 'GPT-6-Sol']);
  });

  it('ticks an older model picked by hand on the first level', () => {
    const items = shownModelMenu(codex, { model: 'gpt-6-sol' });
    expect(ticked(items)).toEqual(['GPT-6-Sol']);
    expect(items.find((i) => i.id === 'more-models')!.children!.map((c) => c.label)).toEqual(['GPT-6.2-Astra']);
  });

  it('drops More models when the lifted row was its only one', () => {
    const items = shownModelMenu(codex.filter((m) => m.id !== 'gpt-6.2-astra'), { model: 'gpt-6-sol' });
    expect(items.some((i) => i.id === 'more-models')).toBe(false);
    expect(ticked(items)).toEqual(['GPT-6-Sol']);
  });

  it('leaves the menu as it is when the model in use is already on the first level', () => {
    const items = shownModelMenu(codex, { model: 'gpt-6.2-sol' });
    expect(ticked(items)).toEqual(['GPT-6.2-Sol']);
    expect(items.find((i) => i.id === 'more-models')!.children).toHaveLength(2);
  });
});
