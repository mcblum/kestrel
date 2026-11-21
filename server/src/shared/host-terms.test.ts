// The words each host uses for its change requests, and the default for an unknown host.
import { describe, expect, it } from 'vitest';
import { hostTerms, isHostKind, requestLabel, requestNumber } from './host-terms.ts';

describe('hostTerms', () => {
  it('says pull request, PR and # on GitHub', () => {
    const terms = hostTerms('github');
    expect([terms.service, terms.short, terms.long, terms.longTitle, terms.plural]).toEqual(['GitHub', 'PR', 'pull request', 'Pull request', 'pull requests']);
    expect(requestNumber(terms, 12)).toBe('#12');
    expect(requestLabel(terms, 12)).toBe('PR #12');
  });
  it('says merge request, MR and ! on GitLab', () => {
    const terms = hostTerms('gitlab');
    expect([terms.service, terms.short, terms.long, terms.longTitle, terms.plural]).toEqual(['GitLab', 'MR', 'merge request', 'Merge request', 'merge requests']);
    expect(requestNumber(terms, 12)).toBe('!12');
    expect(requestLabel(terms, 12)).toBe('MR !12');
  });
  it('uses GitHub’s words when the host is not known', () => {
    expect(hostTerms(null)).toEqual(hostTerms('github'));
    expect(hostTerms('bitbucket' as never)).toEqual(hostTerms('github'));
    expect(isHostKind('gitlab')).toBe(true);
    expect(isHostKind('GitLab')).toBe(false);
  });
});
