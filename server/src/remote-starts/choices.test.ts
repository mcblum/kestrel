import { describe, expect, it } from 'vitest';
import { deskLeadChoices } from './choices.ts';

describe('deskLeadChoices', () => {
  it('is what the New session box would start with, and never Bypass', () => {
    const stored = JSON.stringify({ remembered: { agent: 'codex', projectId: null, byAgent: { codex: { model: 'gpt-5', effort: 'high', fast: true, permission: 'auto' } } } });
    expect(deskLeadChoices(stored)).toEqual({ agent: 'codex', model: 'gpt-5', effort: 'high', fast: true, permission: 'auto' });
    const bypass = JSON.stringify({ remembered: { agent: 'claude', projectId: null, byAgent: { claude: { model: '', effort: '', fast: false, permission: 'bypass' } } } });
    expect(deskLeadChoices(bypass).permission).toBe('auto');
  });

  it('falls back to the defaults when nothing is stored or it cannot be read', () => {
    expect(deskLeadChoices(null)).toMatchObject({ agent: 'claude' });
    expect(deskLeadChoices('not json')).toEqual(deskLeadChoices(null));
  });
});
