// A session's requests as the union of its current branch's and its linked ones (session-requests.ts):
// what gets recorded (new links and the state each request was seen in), the order, de-duplication,
// links the host no longer has, and a session with no branch. Sources are plain functions; nothing
// calls gh or glab.
import { describe, expect, it } from 'vitest';
import type { RequestLink } from '../model.ts';
import type { PullRequest, PullRequestLookup } from '../shared/details.ts';
import type { HostKind } from '../shared/host-terms.ts';
import { ready, unavailable, type Sourced } from '../shared/sourced.ts';
import type { ByNumberProvider } from './by-number.ts';
import { fetchLinked, linkedRequestsFor, linksCacheKey, mergeRequests, missingLinks, NO_BRANCH, seenLinked, seenOnBranch, sessionPullRequests, type NewRequestLink, type SessionRequestSources } from './session-requests.ts';

const LINKED_AT = 1_000;
const pr = (number: number, state: PullRequest['state'] = 'open'): PullRequest => ({ number, title: `#${number}`, state, checks: 'none', review: 'none', url: `https://github.com/o/r/pull/${number}` });
const link = (number: number, branch: string, host: HostKind = 'github'): RequestLink => ({ host, number, url: `https://github.com/o/r/pull/${number}`, branch, linkedAt: LINKED_AT });
const lookup = (pullRequests: PullRequest[], host: HostKind = 'github'): Sourced<PullRequestLookup> => ready({ host, pullRequests });

/** A host with these requests on these branches; anything else is not found. */
function host(branches: Record<string, PullRequest[]>, kind: HostKind = 'github') {
  const asked: string[] = [];
  const all = Object.values(branches).flat();
  const byNumber: ByNumberProvider = { pullRequestByNumber: async (_repo, n) => (asked.push(`view ${n}`), ready(all.find((p) => p.number === n) ?? null)) };
  const sources: SessionRequestSources = {
    pullRequestsFor: async (_repo, branch) => (asked.push(`list ${branch}`), lookup(branches[branch] ?? [], kind)),
    linkedRequests: (repo, links) => fetchLinked(byNumber, kind, repo, links),
  };
  return { sources, asked };
}

function recorder() {
  const recorded: NewRequestLink[][] = [];
  return { recorded, record: async (links: NewRequestLink[]) => recorded.push(links) };
}

describe('the pure parts', () => {
  it('sees the branch requests as links on that branch, each with its state', () => {
    expect(seenOnBranch([pr(3, 'merged'), pr(4)], 'github', 'feat/b')).toEqual([
      { host: 'github', number: 3, url: pr(3).url, branch: 'feat/b', state: 'merged' },
      { host: 'github', number: 4, url: pr(4).url, branch: 'feat/b', state: 'open' },
    ]);
  });

  it('sees fetched linked requests as their own links, leaving out any not linked on that host', () => {
    expect(seenLinked([pr(3, 'closed'), pr(5)], 'github', [link(3, 'feat/a'), link(5, 'feat/c', 'gitlab')])).toEqual([{ host: 'github', number: 3, url: pr(3).url, branch: 'feat/a', state: 'closed' }]);
  });

  it('finds the links for this host that the branch lookup did not return', () => {
    expect(missingLinks([link(1, 'a'), link(2, 'b'), link(3, 'c', 'gitlab')], 'github', [pr(2)])).toEqual([link(1, 'a')]);
  });

  it('merges newest number first, keeping the current branch copy of a duplicate', () => {
    const current = { ...pr(5), title: 'current' };
    expect(mergeRequests([pr(2), current], [pr(9), { ...pr(5), title: 'linked' }, pr(1)]).map((p) => [p.number, p.title])).toEqual([[9, '#9'], [5, 'current'], [2, '#2'], [1, '#1']]);
  });

  it('keys the cache on links from other branches only, in a stable order', () => {
    const links = [link(4, 'feat/b'), link(2, 'feat/a'), link(7, 'feat/now')];
    expect(linksCacheKey(links, 'feat/now')).toBe('github:2,github:4');
    expect(linksCacheKey([...links].reverse(), 'feat/now')).toBe('github:2,github:4');
    expect(linksCacheKey(links, null)).toBe('github:2,github:4,github:7');
  });
});

describe('sessionPullRequests', () => {
  it('records what the current branch has and the earlier links, each in the state seen, and returns them all', async () => {
    const { sources } = host({ 'feat/a': [pr(10, 'merged')], 'feat/b': [pr(12)] });
    const { recorded, record } = recorder();
    const answer = await sessionPullRequests(sources, '/repo', 'feat/b', [link(10, 'feat/a')], record);
    expect(answer).toEqual(lookup([pr(12), pr(10, 'merged')]));
    expect(recorded).toEqual([
      [
        { host: 'github', number: 12, url: pr(12).url, branch: 'feat/b', state: 'open' },
        { host: 'github', number: 10, url: pr(10).url, branch: 'feat/a', state: 'merged' },
      ],
    ]);
  });

  it('asks for no extra request when every link is on the branch, and records the state it saw', async () => {
    const { sources, asked } = host({ 'feat/a': [pr(10, 'draft')] });
    const { recorded, record } = recorder();
    expect(await sessionPullRequests(sources, '/repo', 'feat/a', [link(10, 'feat/a')], record)).toEqual(lookup([pr(10, 'draft')]));
    expect(recorded).toEqual([[{ host: 'github', number: 10, url: pr(10).url, branch: 'feat/a', state: 'draft' }]]);
    expect(asked).toEqual(['list feat/a']);
  });

  it('records nothing when the branch has no request and there are no links', async () => {
    const { sources } = host({});
    const { recorded, record } = recorder();
    expect(await sessionPullRequests(sources, '/repo', 'feat/a', [], record)).toEqual(lookup([]));
    expect(recorded).toEqual([]);
  });

  it('leaves out a linked request the host no longer has, without unlinking it', async () => {
    const { sources } = host({ 'feat/b': [pr(12)] });
    const { recorded, record } = recorder();
    expect(await sessionPullRequests(sources, '/repo', 'feat/b', [link(10, 'feat/a'), link(12, 'feat/b')], record)).toEqual(lookup([pr(12)]));
    expect(recorded.flat().map((l) => l.number)).toEqual([12]);
  });

  it('answers with the linked requests when the session has no branch, recording their states, and unavailable with none', async () => {
    const { sources, asked } = host({ 'feat/a': [pr(10, 'closed')], 'feat/b': [pr(12)] });
    const { recorded, record } = recorder();
    expect(await sessionPullRequests(sources, '/repo', null, [link(10, 'feat/a'), link(12, 'feat/b')], record)).toEqual(lookup([pr(12), pr(10, 'closed')]));
    expect(asked.every((a) => a.startsWith('view'))).toBe(true);
    expect(recorded.flat().map((l) => [l.number, l.branch, l.state])).toEqual([[12, 'feat/b', 'open'], [10, 'feat/a', 'closed']]);
    expect(await sessionPullRequests(sources, '/repo', null, [], record)).toEqual(unavailable(NO_BRANCH));
  });

  it('gives the branch lookup failure as it is', async () => {
    const sources: SessionRequestSources = { pullRequestsFor: async () => unavailable('gh is not signed in'), linkedRequests: async () => lookup([]) };
    expect(await sessionPullRequests(sources, '/repo', 'feat/a', [link(1, 'x')], recorder().record)).toEqual(unavailable('gh is not signed in'));
  });

  it('still answers with the branch when the linked requests cannot be fetched', async () => {
    const sources: SessionRequestSources = { pullRequestsFor: async () => lookup([pr(3)]), linkedRequests: async () => unavailable('offline') };
    expect(await sessionPullRequests(sources, '/repo', 'feat/a', [link(1, 'x')], recorder().record)).toEqual(lookup([pr(3)]));
  });
});

describe('fetching linked requests', () => {
  const failing: ByNumberProvider = { pullRequestByNumber: async () => unavailable('gh did not answer') };

  it('is unavailable only when every one could not be asked', async () => {
    expect(await fetchLinked(failing, 'github', '/repo', [link(1, 'a'), link(2, 'b')])).toEqual(unavailable('gh did not answer'));
    const some: ByNumberProvider = { pullRequestByNumber: async (_r, n) => (n === 1 ? ready(pr(1)) : unavailable('gh did not answer')) };
    expect(await fetchLinked(some, 'github', '/repo', [link(1, 'a'), link(2, 'b')])).toEqual(lookup([pr(1)]));
  });

  it('asks the host the origin calls for, about its own links only', async () => {
    const asked: number[] = [];
    const gitlab: ByNumberProvider = { pullRequestByNumber: async (_r, n) => (asked.push(n), ready(pr(n))) };
    const sources = { github: failing, gitlab, glabSignIn: async () => ({ signedIn: true as const }), originOf: async () => 'git@gitlab.example:o/r.git' };
    expect(await linkedRequestsFor(sources, '/repo', [link(4, 'a', 'gitlab'), link(5, 'b')])).toEqual(lookup([pr(4)], 'gitlab'));
    expect(asked).toEqual([4]);
    expect(await linkedRequestsFor({ ...sources, originOf: async () => null }, '/repo', [link(4, 'a', 'gitlab')])).toEqual(unavailable('This repository has no remote'));
  });
});
