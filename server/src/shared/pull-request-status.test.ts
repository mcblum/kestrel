// A pull request's status at a glance and its Merge row, from the host-neutral readiness both GitHub
// and GitLab map into; and the lookup answer's check.
import { describe, expect, it } from 'vitest';
import { isPullRequestLookup, lookupHost, mergeText, primaryPullRequest, pullRequestStatus, type PullRequest } from './details.ts';

const open: PullRequest = { number: 307, title: 'Fix timeout handling', state: 'open', checks: 'passing', review: 'approved', url: 'https://github.com/example/repo/pull/307' };

describe('PR status at a glance', () => {
  it('requires affirmative host merge readiness for green', () => {
    expect(pullRequestStatus(open).tone).toBe('muted');
    expect(pullRequestStatus({ ...open, readiness: 'unknown' }).tone).toBe('muted');
    expect(pullRequestStatus({ ...open, readiness: 'ready' })).toEqual({ label: 'Ready to merge', tone: 'green' });
  });
  it('prioritizes failure, pending review, and draft over readiness', () => {
    const ready: PullRequest = { ...open, readiness: 'ready' };
    expect(pullRequestStatus({ ...ready, checks: 'failing' }).tone).toBe('red');
    expect(pullRequestStatus({ ...ready, checks: 'running' }).tone).toBe('amber');
    expect(pullRequestStatus({ ...ready, review: 'review-required' }).tone).toBe('amber');
    expect(pullRequestStatus({ ...ready, state: 'draft', checks: 'failing' })).toEqual({ label: 'Draft', tone: 'muted' });
  });
  it('distinguishes conflicts, merged, closed, behind and blocked', () => {
    expect(pullRequestStatus({ ...open, readiness: 'conflicts' })).toEqual({ label: 'Merge conflicts', tone: 'red' });
    expect(pullRequestStatus({ ...open, state: 'merged', checks: 'failing' }).label).toBe('Merged');
    expect(pullRequestStatus({ ...open, state: 'closed' }).label).toBe('Closed');
    expect(pullRequestStatus({ ...open, readiness: 'behind' })).toEqual({ label: 'Branch behind', tone: 'amber' });
    expect(pullRequestStatus({ ...open, readiness: 'blocked' })).toEqual({ label: 'Merge blocked', tone: 'amber' });
  });
  it('prefers an active PR over an older completed one', () => {
    expect(primaryPullRequest([{ ...open, number: 306, state: 'merged' }, open])?.number).toBe(307);
  });
});

describe('the Merge row', () => {
  it('says the state once it is not open, else what the host says about merging', () => {
    expect(mergeText({ ...open, state: 'merged' })).toBe('Merged');
    expect(mergeText({ ...open, state: 'closed' })).toBe('Closed');
    expect(mergeText({ ...open, state: 'draft', readiness: 'ready' })).toBe('Draft — not ready for review');
    expect(mergeText({ ...open, readiness: 'ready' })).toBe('Ready to merge');
    expect(mergeText({ ...open, readiness: 'conflicts' })).toBe('Conflicts must be resolved');
    expect(mergeText({ ...open, readiness: 'behind' })).toBe('Branch is behind its base');
    expect(mergeText({ ...open, readiness: 'blocked' })).toBe('Blocked by the host’s merge rules');
    expect(mergeText(open)).toBeNull();
    expect(pullRequestStatus(open).label).toBe('Open');
  });
});

describe('the lookup answer', () => {
  it('names its host, and only a known host with a list of pull requests passes', () => {
    expect(isPullRequestLookup({ host: 'gitlab', pullRequests: [open] })).toBe(true);
    expect(isPullRequestLookup({ host: 'bitbucket', pullRequests: [] })).toBe(false);
    expect(isPullRequestLookup([open])).toBe(false);
    expect(isPullRequestLookup({ host: 'github', pullRequests: [{ ...open, readiness: 'CLEAN' }] })).toBe(false);
    expect(lookupHost({ state: 'ready', value: { host: 'gitlab' } })).toBe('gitlab');
    expect(lookupHost({ state: 'loading' })).toBeNull();
  });
});
