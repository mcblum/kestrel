import { describe, expect, it } from 'vitest';
import { titleFrom } from '../title.ts';
import { AGENT_TITLE_MAX, checkAgentTitle, checkAgentTitles } from './agent-title.ts';

describe('the title an agent gives a session it starts', () => {
  it('is trimmed, with its spaces collapsed; none given means the brief titles it', () => {
    expect(checkAgentTitle('  Terraform:   Cognito OAuth client ')).toEqual({ title: 'Terraform: Cognito OAuth client' });
    expect(checkAgentTitle(undefined)).toEqual({ title: null });
  });

  it('is refused, with a reason, when empty, too long, only a ticket key, or holding an address', () => {
    expect(checkAgentTitle('   ')).toMatchObject({ refusal: expect.stringMatching(/The title is empty/) });
    expect(checkAgentTitle('x'.repeat(AGENT_TITLE_MAX))).toEqual({ title: 'x'.repeat(AGENT_TITLE_MAX) });
    expect(checkAgentTitle('x'.repeat(AGENT_TITLE_MAX + 1))).toMatchObject({ refusal: expect.stringMatching(new RegExp(`keep it to ${AGENT_TITLE_MAX}`)) });
    expect(checkAgentTitle(' LH-140850 ')).toMatchObject({ refusal: expect.stringMatching(/"LH-140850" is only a ticket key/) });
    expect(checkAgentTitle('OAuth client https://example.atlassian.net/browse/LH-1')).toMatchObject({ refusal: expect.stringMatching(/contains an address/) });
    expect(checkAgentTitle('See www.example.com')).toMatchObject({ refusal: expect.stringMatching(/contains an address/) });
    // A key with words after it names the part well enough.
    expect(checkAgentTitle('LH-140850: OAuth client')).toEqual({ title: 'LH-140850: OAuth client' });
  });

  it('refuses two tasks of one call titled alike, naming them, and says every problem at once', () => {
    expect(checkAgentTitles(['API: scopes', undefined, 'UI: login'])).toEqual({ titles: ['API: scopes', null, 'UI: login'] });
    const same = checkAgentTitles(['OAuth client', 'Docs', 'oauth  client']);
    expect(same).toMatchObject({ refusal: 'Tasks 1 and 3 are both titled "oauth client". Give each part its own title, so the user can tell them apart.' });
    const both = checkAgentTitles(['LH-1', 'Docs', 'Docs']);
    expect('refusal' in both && both.refusal.split('\n')).toEqual([expect.stringMatching(/^Task 1: The title "LH-1" is only a ticket key/), expect.stringMatching(/^Tasks 2 and 3 are both titled "Docs"/)]);
  });
});

describe('a title made from the brief', () => {
  it('skips a leading ticket key and address, so the fallback reads as the work', () => {
    expect(titleFrom('LH-140850 https://acme.atlassian.net/browse/LH-140850. Create the Cognito OAuth client in Terraform')).toBe('Create the Cognito OAuth client in Terraform');
    expect(titleFrom('[LH-140850] (https://acme.atlassian.net/browse/LH-140850) - Add the login page')).toBe('Add the login page');
    expect(titleFrom('LH-140850: Add the login page')).toBe('Add the login page');
  });

  it('keeps a brief that starts with words, and the key alone when nothing else is on the line', () => {
    expect(titleFrom('Fix the null check in B.\nIt crashes.')).toBe('Fix the null check in B.');
    expect(titleFrom('Use https://example.com as the base')).toBe('Use https://example.com as the base');
    expect(titleFrom('LH-140850')).toBe('LH-140850');
  });
});
