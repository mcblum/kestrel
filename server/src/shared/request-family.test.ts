// A session's family for the header's chip: who is in it (a workstream, the same on every session, or
// a session's own delegates), the lead first and the rest needs-you first, and the words, which read
// without colour.
import { describe, expect, it } from 'vitest';
import type { Link } from '../model.ts';
import type { PullRequest, PullRequestLookup } from './details.ts';
import { attentionWords, familyCountText, familyDescription, familyOf, type FamilySession, type FamilyState } from './request-family.ts';
import { ready, type Sourced } from './sourced.ts';

const pr = (number: number, fields: Partial<PullRequest> = {}): PullRequest => ({ number, title: `Request ${number}`, state: 'open', checks: 'passing', review: 'none', url: `https://github.com/o/r/pull/${number}`, ...fields });
const link = (parentId: string, childId: string, kind: Link['kind'] = 'delegate'): Link => ({ id: `${parentId}>${childId}`, parentId, childId, kind });
const session = (id: string, fields: Partial<FamilySession> = {}): FamilySession => ({ id, title: id.toUpperCase(), state: 'done', note: '', updatedAt: 0, lastActivityAt: 0, ...fields });

// "lead" leads a workstream: a (failing), b (waiting on the user, no request), c (running), g a guest in a's worktree.
// "solo" is in no workstream and delegated to x and y.
const state: FamilyState = {
  sessions: [session('lead'), session('a'), session('b', { state: 'attention' }), session('c'), session('g', { hostId: 'a' }), session('solo'), session('x'), session('y'), session('alone')],
  links: [link('lead', 'a'), link('lead', 'b'), link('lead', 'c'), link('a', 'g'), link('solo', 'x'), link('solo', 'y')],
  workstreams: [{ id: 'w1', name: 'Usage-based pricing', sessionIds: ['lead', 'a', 'b', 'c', 'g'] }],
};
const lookups: Record<string, Sourced<PullRequestLookup>> = {
  lead: ready({ host: 'github', pullRequests: [pr(1)] }),
  a: ready({ host: 'github', pullRequests: [pr(11, { checks: 'failing', headSha: 'abc123def456', failedChecks: [{ name: 'jenkins', url: 'https://ci.example.com/1' }] })] }),
  c: ready({ host: 'github', pullRequests: [pr(12, { checks: 'running' })] }),
  x: ready({ host: 'gitlab', pullRequests: [pr(21)] }),
};
const lookupOf = (id: string) => lookups[id];

describe('a session’s family', () => {
  it('is its workstream, the same on every session of it, the lead first and what needs the user next', () => {
    const fromLead = familyOf('lead', state, lookupOf)!;
    expect(familyOf('c', state, lookupOf)).toEqual(fromLead);
    expect(fromLead.workstream).toEqual({ id: 'w1', name: 'Usage-based pricing' });
    expect(fromLead.members.map((m) => [m.session.id, m.isLead])).toEqual([
      ['lead', true],
      ['b', false], // waiting on the user
      ['a', false], // its request failed
      ['g', false], // the guest in a's worktree, after it in the tree's order
      ['c', false],
    ]);
    expect(fromLead.members.map((m) => m.request?.pr.number ?? null)).toEqual([1, null, 11, null, 12]); // a guest has no request of its own
    expect(fromLead.childRequests.map((r) => r.pr.number)).toEqual([11, 12]);
  });

  it('is a session’s own delegates when it is in no workstream, and nothing for a session with neither', () => {
    const solo = familyOf('solo', state, lookupOf)!;
    expect(solo.workstream).toBeNull();
    expect(solo.members.map((m) => m.session.id)).toEqual(['solo', 'x', 'y']);
    expect(familyOf('x', state, lookupOf)).toBeNull();
    expect(familyOf('alone', state, lookupOf)).toBeNull();
  });
});

describe('the chip’s words', () => {
  it('counts the child requests in the host’s words and says what needs the user, dropping the session count', () => {
    const family = familyOf('lead', state, lookupOf)!;
    expect(familyCountText(family)).toBe('2 child PRs · 1 failing');
    expect(familyDescription(family)).toBe('Workstream Usage-based pricing · 2 child PRs · 1 failing');
  });

  it('counts sessions when no child has a request, and names a session’s own delegates as the ones it started', () => {
    expect(familyCountText(familyOf('lead', state, () => undefined)!)).toBe('5 sessions');
    expect(familyCountText(familyOf('solo', state, lookupOf)!)).toBe('2 sessions it started · 1 MR');
    expect(familyCountText(familyOf('solo', state, () => undefined)!)).toBe('2 sessions it started');
  });

  it('names each reason once per request that has it', () => {
    const family = familyOf('lead', state, lookupOf)!;
    const both = { ...family.childRequests[0]!, reasons: ['checks-failed', 'conflicts'] as const };
    expect(attentionWords([both, { ...both, reasons: ['changes-requested'] }])).toEqual(['1 failing', '1 with conflicts', '1 changes requested']);
  });
});
