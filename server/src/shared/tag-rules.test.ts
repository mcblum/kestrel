import { describe, expect, it } from 'vitest';
import { alwaysLabel, DEFAULT_TAG_PREFS, kindLabel, parseRuleKey, ruleFor, ruleKey, ruleRows, sanitizeTagPrefs, withRule } from './tag-rules.ts';

describe('rule keys', () => {
  it('are category and source, the source without case; none given is "any"', () => {
    expect(ruleKey('ticket', 'Jira')).toBe('ticket:jira');
    expect(ruleKey('ticket', '  JIRA ')).toBe('ticket:jira');
    expect(ruleKey('release')).toBe('release:any');
    expect(ruleKey('feature', '')).toBe('feature:any');
    expect(parseRuleKey('ticket:jira')).toEqual({ category: 'ticket', source: 'jira' });
    expect(parseRuleKey('epic:jira')).toBeNull();
    expect(parseRuleKey('ticket')).toBeNull();
  });

  it('default to Ask; Ask removes a stored rule', () => {
    expect(ruleFor(DEFAULT_TAG_PREFS, 'ticket', 'Jira')).toBe('ask');
    const always = withRule(DEFAULT_TAG_PREFS, ruleKey('ticket', 'Jira'), 'always', 'Jira');
    expect(ruleFor(always, 'ticket', 'jira')).toBe('always');
    expect(withRule(always, 'ticket:jira', 'ask').rules).toEqual({});
    expect(DEFAULT_TAG_PREFS.rules).toEqual({}); // never changed in place
  });
});

describe('labels', () => {
  it('word the Always button by category and source', () => {
    expect(alwaysLabel('ticket', 'Jira')).toBe('Always tag sessions with Jira tickets');
    expect(alwaysLabel('ticket', null)).toBe('Always tag sessions with tickets');
    expect(alwaysLabel('release', 'GitHub')).toBe('Always tag sessions with release tags');
    expect(alwaysLabel('feature')).toBe('Always tag sessions with feature tags');
    expect(kindLabel('release')).toBe('Releases');
  });

  it('list the stored rules sorted by label, with the source as first written', () => {
    let prefs = withRule(DEFAULT_TAG_PREFS, ruleKey('release'), 'never');
    prefs = withRule(prefs, ruleKey('ticket', 'Jira'), 'always', 'Jira');
    prefs = withRule(prefs, ruleKey('ticket', 'linear'), 'never');
    expect(ruleRows(prefs)).toEqual([
      { key: 'ticket:jira', label: 'Jira tickets', value: 'always' },
      { key: 'ticket:linear', label: 'linear tickets', value: 'never' },
      { key: 'release:any', label: 'Releases', value: 'never' },
    ]);
  });
});

describe('sanitizeTagPrefs', () => {
  it('keeps what is valid and drops the rest', () => {
    expect(sanitizeTagPrefs({ enabled: false, rules: { 'ticket:jira': { value: 'always', source: 'Jira' }, 'bad:key': { value: 'always' }, 'release:any': { value: 'maybe' } } })).toEqual({ enabled: false, rules: { 'ticket:jira': { value: 'always', source: 'Jira' } } });
    expect(sanitizeTagPrefs('nonsense')).toEqual(DEFAULT_TAG_PREFS);
    expect(sanitizeTagPrefs({})).toEqual({ enabled: true, rules: {} });
  });
});
