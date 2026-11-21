// The request pill's data: which actions a request offers, when requests group, their order, the
// group label and the strip's segments.
import { describe, expect, it } from 'vitest';
import type { PullRequest } from './details.ts';
import { hostTerms } from './host-terms.ts';
import { groupDescription, groupLabel, groupOrder, requestActions, showsGroup, stripSegments } from './request-group.ts';

const base: PullRequest = { number: 1, title: 'Base', state: 'open', checks: 'none', review: 'none', url: 'https://example.test/1' };
const failing: PullRequest = { ...base, number: 12, checks: 'failing', checksUrl: 'https://example.test/12/checks' };
const ready: PullRequest = { ...base, number: 13, checks: 'passing', review: 'approved', readiness: 'ready' };
const merged: PullRequest = { ...base, number: 9, state: 'merged' };
const draft: PullRequest = { ...base, number: 20, state: 'draft' };
const closed: PullRequest = { ...base, number: 5, state: 'closed' };
const github = hostTerms('github');
const gitlab = hostTerms('gitlab');

describe('requestActions', () => {
  it('offers merging for a ready request only where merging is possible', () => {
    expect(requestActions(ready, true)).toEqual({ external: ready.url, status: { kind: 'merge' } });
    expect(requestActions(ready, false)).toEqual({ external: ready.url, status: { kind: 'open' } });
  });
  it('opens the pipeline for failing or running checks when the host gave a link', () => {
    expect(requestActions(failing, true).status).toEqual({ kind: 'checks', url: failing.checksUrl });
    expect(requestActions({ ...failing, checks: 'running' }, true).status).toEqual({ kind: 'checks', url: failing.checksUrl });
    expect(requestActions({ ...failing, checksUrl: undefined }, true).status).toEqual({ kind: 'open' });
  });
  it('opens the tab otherwise, and has no external link without a url', () => {
    expect(requestActions(merged, true).status).toEqual({ kind: 'open' });
    expect(requestActions({ ...merged, url: '' }, true).external).toBeNull();
  });
});

describe('showsGroup', () => {
  it('groups only more than one request', () => {
    expect(showsGroup([])).toBe(false);
    expect(showsGroup([ready])).toBe(false);
    expect(showsGroup([ready, merged])).toBe(true);
  });
});

describe('groupOrder', () => {
  it('puts open, then draft, merged, closed, keeping the host order within each', () => {
    const second: PullRequest = { ...base, number: 14 };
    expect(groupOrder([closed, merged, failing, draft, second]).map((p) => p.number)).toEqual([12, 14, 20, 9, 5]);
  });
  it('does not change the list it was given', () => {
    const list = [merged, ready];
    groupOrder(list);
    expect(list.map((p) => p.number)).toEqual([9, 13]);
  });
});

describe('groupLabel', () => {
  it('counts in the host’s short words', () => {
    expect(groupLabel(github, 3)).toBe('3 PRs');
    expect(groupLabel(gitlab, 2)).toBe('2 MRs');
  });
});

describe('stripSegments', () => {
  it('gives one segment per request, in group order, in its status tone', () => {
    expect(stripSegments(github, [merged, failing, ready])).toEqual([
      { number: 12, tone: 'red', label: '#12 · Checks failed' },
      { number: 13, tone: 'green', label: '#13 · Ready to merge' },
      { number: 9, tone: 'purple', label: '#9 · Merged' },
    ]);
  });
  it('uses the host’s sigil', () => {
    expect(stripSegments(gitlab, [merged])[0]!.label).toBe('!9 · Merged');
  });
});

describe('groupDescription', () => {
  it('names the count and each request’s status', () => {
    expect(groupDescription(github, [merged, failing])).toBe('2 pull requests: #12 Checks failed, #9 Merged');
  });
});
