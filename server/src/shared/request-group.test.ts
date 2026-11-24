// The request pill's data: which actions a request offers, when requests group, their order, the
// group label and the strip's segments.
import { describe, expect, it } from 'vitest';
import type { PullRequest } from './details.ts';
import { hostTerms } from './host-terms.ts';
import { checksAction, failedChecksMenu, groupDescription, groupLabel, groupOrder, requestActions, showsGroup, stripSegments } from './request-group.ts';

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

describe('where failed checks lead: each check’s own page, the host’s checks page only as a fallback', () => {
  const jenkins = { name: 'continuous-integration/jenkins/pr-merge', url: 'https://ci.example.test/job/app/PR-12/3/display/redirect' };
  const actions = { name: 'lint', url: 'https://github.com/example/app/actions/runs/9/job/1' };
  const unlinked = { name: 'license/cla' };

  it('opens the one failed check’s own page (a Jenkins status, not GitHub’s checks page)', () => {
    expect(requestActions({ ...failing, failedChecks: [jenkins] }, true).status).toEqual({ kind: 'checks', url: jenkins.url });
  });
  it('lists several failed checks, each with its own link, the unlinked one named but not a link, then all checks', () => {
    const status = requestActions({ ...failing, failedChecks: [actions, jenkins, unlinked] }, true).status;
    expect(status).toEqual({ kind: 'failed-checks', checks: [actions, jenkins, unlinked], checksUrl: failing.checksUrl });
    if (status.kind !== 'failed-checks') throw new Error('expected a list');
    const menu = failedChecksMenu(status, github.service);
    expect(menu.map((m) => [m.label, m.action, m.disabled ?? false])).toEqual([
      ['lint', { type: 'open-link', url: actions.url }, false],
      [jenkins.name, { type: 'open-link', url: jenkins.url }, false],
      ['license/cla', undefined, true],
      ['All checks on GitHub', { type: 'open-link', url: failing.checksUrl }, false],
    ]);
    expect(menu[0]!.heading).toBe('Failed checks');
    expect(menu[2]!.hint).toBe('GitHub gave no link for this check.');
  });
  it('falls back to the checks page when no failed check has a link of its own, and while checks run', () => {
    expect(checksAction({ ...failing, failedChecks: [unlinked] })).toEqual({ kind: 'checks', url: failing.checksUrl });
    expect(checksAction({ ...failing, failedChecks: [unlinked, { name: 'b' }] })).toEqual({ kind: 'checks', url: failing.checksUrl });
    expect(checksAction({ ...failing, checks: 'running', failedChecks: [jenkins] })).toEqual({ kind: 'checks', url: failing.checksUrl });
    expect(checksAction({ ...failing, checksUrl: undefined, failedChecks: [unlinked] })).toBeNull();
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
