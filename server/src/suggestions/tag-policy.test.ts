import { describe, expect, it } from 'vitest';
import type { Suggestion } from '../shared/suggestions.ts';
import { DEFAULT_TAG_PREFS, ruleKey, withRule } from '../shared/tag-rules.ts';
import { groundTag, MAX_TAG_SUGGESTIONS, parseTagProposal, tagVerdict, type TagProposal, type TagSituation } from './tag-policy.ts';

const proposal: TagProposal = { tag: 'PROJ-482', category: 'ticket', source: 'Jira', reason: 'named' };
const situation = (over: Partial<TagSituation> = {}): TagSituation => ({ prefs: DEFAULT_TAG_PREFS, sessionTags: [], parentTags: [], earlier: [], ...over });
const earlier = (tag: string, over: Partial<Suggestion> = {}): Suggestion => ({ id: tag, sessionId: 's', kind: 'tag', title: '', payload: { tag, category: 'ticket' }, buttons: [], state: 'answered', createdAt: 0, ...over });

describe('parseTagProposal', () => {
  it('takes a tag, a category, an optional source and a reason', () => {
    expect(parseTagProposal({ tag: ' PROJ-482 ', category: 'ticket', source: ' Jira ', reason: 'The task  names it' })).toEqual({ tag: 'PROJ-482', category: 'ticket', source: 'Jira', reason: 'The task names it' });
    expect(parseTagProposal({ tag: 'v2.3', category: 'release' })).toEqual({ tag: 'v2.3', category: 'release', source: null, reason: '' });
  });

  it('refuses a missing tag or an unknown category', () => {
    expect(parseTagProposal({ category: 'ticket' })).toHaveProperty('reason');
    expect('tag' in parseTagProposal({ tag: 'X-1', category: 'epic' })).toBe(false);
  });
});

describe('groundTag', () => {
  it('accepts an existing workspace tag, keeping its own case', () => {
    expect(groundTag('proj-1', { existingTags: ['PROJ-1'], texts: [] })).toEqual({ tag: 'PROJ-1' });
  });

  it('turns an existing tag plus extra words into the existing tag, even when the longer name was written', () => {
    expect(groundTag('Argus CLI', { existingTags: ['Billing', 'Argus'], texts: ['add a flag to the Argus CLI'] })).toEqual({ tag: 'Argus' });
  });

  it('accepts a tag named (any case) in the user messages, title or branch', () => {
    expect(groundTag('PROJ-482', { existingTags: [], texts: ['fix the hang for proj-482 please'] })).toEqual({ tag: 'PROJ-482' });
    expect(groundTag('PROJ-482', { existingTags: [], texts: ['', 'kestrel/proj-482-upload-hang'] })).toEqual({ tag: 'PROJ-482' });
  });

  it('refuses a tag the model made up', () => {
    const result = groundTag('PROJ-999', { existingTags: ['PROJ-1'], texts: ['fix PROJ-482'] });
    expect(result).toHaveProperty('refused');
    expect((result as { refused: string }).refused).toContain('not a tag in this workspace');
  });
});

describe('tagVerdict', () => {
  it('asks by default', () => {
    expect(tagVerdict(proposal, situation())).toEqual({ type: 'ask' });
  });

  it('applies at once under an Always rule, and stays quiet under Never', () => {
    const always = withRule(DEFAULT_TAG_PREFS, ruleKey('ticket', 'Jira'), 'always', 'Jira');
    expect(tagVerdict(proposal, situation({ prefs: always }))).toEqual({ type: 'auto' });
    const never = withRule(DEFAULT_TAG_PREFS, ruleKey('ticket', 'jira'), 'never');
    const verdict = tagVerdict(proposal, situation({ prefs: never }));
    expect(verdict).toMatchObject({ type: 'skip' });
    expect((verdict as { text: string }).text).toContain('jira tickets');
  });

  it('keeps rules apart by source: a Jira rule does not cover Linear or no source', () => {
    const always = withRule(DEFAULT_TAG_PREFS, ruleKey('ticket', 'Jira'), 'always', 'Jira');
    expect(tagVerdict({ ...proposal, source: 'Linear' }, situation({ prefs: always }))).toEqual({ type: 'ask' });
    expect(tagVerdict({ ...proposal, source: null }, situation({ prefs: always }))).toEqual({ type: 'ask' });
  });

  it('refuses when tag suggestions are switched off', () => {
    expect(tagVerdict(proposal, situation({ prefs: { ...DEFAULT_TAG_PREFS, enabled: false } }))).toMatchObject({ type: 'refuse' });
  });

  it('never suggests a tag the session, or the session it came from, already has', () => {
    expect(tagVerdict(proposal, situation({ sessionTags: ['proj-482'] }))).toMatchObject({ type: 'skip' });
    expect(tagVerdict(proposal, situation({ parentTags: ['PROJ-482'] }))).toMatchObject({ type: 'skip' });
  });

  it('never suggests a tag again in the same session, even after Not right now', () => {
    expect(tagVerdict(proposal, situation({ earlier: [earlier('proj-482', { state: 'dismissed' })] }))).toMatchObject({ type: 'skip' });
  });

  it('keeps one open tag suggestion at a time', () => {
    expect(tagVerdict(proposal, situation({ earlier: [earlier('OTHER-1', { state: 'open' })] }))).toMatchObject({ type: 'skip', text: expect.stringContaining('waiting') });
  });

  it('stops after the cap; tags applied by a rule do not count', () => {
    const asked = Array.from({ length: MAX_TAG_SUGGESTIONS }, (_, i) => earlier(`A-${i}`));
    expect(tagVerdict(proposal, situation({ earlier: asked }))).toMatchObject({ type: 'skip', text: expect.stringContaining(`${MAX_TAG_SUGGESTIONS}`) });
    const auto = Array.from({ length: MAX_TAG_SUGGESTIONS }, (_, i) => earlier(`A-${i}`, { auto: true }));
    expect(tagVerdict(proposal, situation({ earlier: auto }))).toEqual({ type: 'ask' });
  });
});
