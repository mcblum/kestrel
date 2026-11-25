// The open requests of the sessions a session brought in: who counts (a workstream's other sessions and
// a delegate subtree; a guest once, by its host; never the session itself), what is left out (merged and
// closed), the order (needs you, then worst first), the words, and the menu.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Link } from '../model.ts';
import { broughtInByLead, broughtInDescription, broughtInIds, broughtInRequests, workstreamRequestsDescription, type BroughtInState } from './brought-in-requests.ts';
import type { PullRequest, PullRequestLookup } from './details.ts';
import { DEFAULT_ATTENTION_PREFS } from './request-attention.ts';
import { ready, unavailable, type Sourced } from './sourced.ts';

const pr = (number: number, fields: Partial<PullRequest> = {}): PullRequest => ({ number, title: `Request ${number}`, state: 'open', checks: 'passing', review: 'none', url: `https://github.com/o/r/pull/${number}`, ...fields });
const link = (parentId: string, childId: string, kind: Link['kind'] = 'delegate'): Link => ({ id: `${parentId}>${childId}`, parentId, childId, kind });

// "lead" leads a workstream of four; it delegated to a, b and c; c delegated to d (outside the
// workstream); g is a guest in a's worktree; h is a guest in the lead's own; e was handed off to.
const state: BroughtInState = {
  sessions: [
    { id: 'lead', title: 'Checkout is slow' },
    { id: 'a', title: 'Pricing cache' },
    { id: 'b', title: 'Cart debounce' },
    { id: 'c', title: 'Docs' },
    { id: 'd', title: 'Docs follow-up' },
    { id: 'g', title: 'Design guest', hostId: 'a' },
    { id: 'h', title: 'Lead’s guest', hostId: 'lead' },
    { id: 'e', title: 'Handed off' },
  ],
  links: [link('lead', 'a'), link('lead', 'b'), link('lead', 'c'), link('c', 'd'), link('a', 'g'), link('lead', 'h'), link('lead', 'e', 'handoff')],
  workstreams: [{ sessionIds: ['lead', 'a', 'b', 'c'] }],
};

const lookups: Record<string, Sourced<PullRequestLookup>> = {
  lead: ready({ host: 'github', pullRequests: [pr(1)] }),
  a: ready({ host: 'github', pullRequests: [pr(11, { checks: 'failing', headSha: 'abc123def456', failedChecks: [{ name: 'jenkins', url: 'https://ci.example.com/1' }] })] }),
  b: ready({ host: 'github', pullRequests: [pr(12, { checks: 'running' }), pr(9, { state: 'merged' })] }),
  c: ready({ host: 'github', pullRequests: [pr(13, { state: 'draft' }), pr(8, { state: 'closed' })] }),
  d: ready({ host: 'github', pullRequests: [pr(14, { review: 'approved', readiness: 'ready' })] }),
  e: ready({ host: 'github', pullRequests: [pr(15)] }),
};
const lookupOf = (id: string) => lookups[id];

describe('who a session brought in', () => {
  it('is its delegate subtree and its workstream’s other sessions, never itself nor a handoff', () => {
    expect(broughtInIds('lead', state).sort()).toEqual(['a', 'b', 'c', 'd', 'g', 'h']);
    expect(broughtInIds('c', state)).toEqual(['d']);
    expect(broughtInIds('b', state)).toEqual([]);
  });
});

describe('the open requests of the sessions it brought in', () => {
  it('counts a guest once, by the worktree’s owner, and not the session’s own guest; leaves merged and closed out; worst first', () => {
    const rollup = broughtInRequests('lead', state, lookupOf)!;
    expect(rollup.requests.map((r) => [r.pr.number, r.sessionId])).toEqual([
      [11, 'a'], // checks failed, and needs you
      [12, 'b'], // checks running: amber
      [14, 'd'], // ready: green
      [13, 'c'], // draft: grey
    ]);
    expect(rollup.needsYou).toBe(1);
    expect(rollup.requests[0]).toMatchObject({ needsYou: true, tone: 'red', label: 'Checks failed', sessionTitle: 'Pricing cache' });
    expect(rollup.requests[1]).toMatchObject({ needsYou: false, tone: 'amber', label: 'Checks running' });
  });

  it('follows the choices of Settings → Git: a reason not watched is not "needs you", though it stays red', () => {
    const off = { ...DEFAULT_ATTENTION_PREFS, 'checks-failed': { watch: false, card: 'ask' as const } };
    const rollup = broughtInRequests('lead', state, lookupOf, off)!;
    expect(rollup.needsYou).toBe(0);
    expect(rollup.requests[0]).toMatchObject({ pr: { number: 11 }, needsYou: false, tone: 'red', label: 'Checks failed' });
  });

  it('names every reason a request needs the user for, in the pill’s words', () => {
    const both: Record<string, Sourced<PullRequestLookup>> = { ...lookups, b: ready({ host: 'github' as const, pullRequests: [pr(12, { checks: 'failing', readiness: 'conflicts', headSha: 'def456abc123' })] }) };
    const rollup = broughtInRequests('lead', state, (id) => both[id])!;
    expect(rollup.requests.find((r) => r.pr.number === 12)).toMatchObject({ needsYou: true, label: 'Checks failed · Merge conflicts' });
    expect(rollup.needsYou).toBe(2);
  });

  it('is nothing when none of them has an open request, or their lookups are not in yet', () => {
    expect(broughtInRequests('c', { ...state }, (id) => (id === 'd' ? ready({ host: 'github', pullRequests: [pr(3, { state: 'merged' })] }) : undefined))).toBeNull();
    expect(broughtInRequests('lead', state, (id) => (id === 'lead' ? lookups.lead : unavailable('gh is not signed in')))).toBeNull();
  });

  it('is built for every session that brought others in, once', () => {
    const index = broughtInByLead(state, lookupOf);
    // a's only child is its own guest, which shares a's request: nothing of its own to count.
    expect([...index.keys()].sort()).toEqual(['c', 'lead']);
    expect(index.get('c')!.requests.map((r) => r.pr.number)).toEqual([14]);
    expect(broughtInRequests('a', state, lookupOf)).toBeNull();
  });
});

describe('the words', () => {
  const rollup = broughtInRequests('lead', state, lookupOf)!;

  it('says it in full in the host’s words, for the header’s pill and for the sidebar’s icon and number', () => {
    expect(broughtInDescription(rollup)).toBe('4 open pull requests from the sessions it brought in, 1 needs you');
    expect(workstreamRequestsDescription(rollup)).toBe('4 open pull requests in this workstream’s sessions, 1 needs you');
    expect(workstreamRequestsDescription({ ...rollup, host: 'gitlab', requests: rollup.requests.slice(1, 2), needsYou: 0 })).toBe('1 open merge request in this workstream’s sessions');
  });
});

describe('where the count is drawn', () => {
  const source = (path: string) => readFileSync(new URL(`../../../ui/src/${path}`, import.meta.url), 'utf8');

  it('is drawn from the one derived entry: the header’s family chip, the workstream’s top row, its page, the hover card', () => {
    // The header keeps the session's own request top right and counts the children in the family chip of its second line.
    const header = source('components/SessionBar.tsx');
    expect(header).toMatch(/<FamilyChip sessionId=\{session\.id\} \/>/);
    expect(header).not.toMatch(/BroughtInPill|useBroughtIn/);
    expect(source('components/FamilyChip.tsx')).toMatch(/useFamily\(sessionId\)/);
    const row = source('components/SidebarWorkstreams.tsx');
    expect(row).toMatch(/useBroughtIn\(shape\.leadId\)/);
    expect(row).toMatch(/<BroughtInMark rollup=\{broughtIn\} description=\{workstreamRequestsDescription\(broughtIn\)\} \/>/);
    const page = source('pages/WorkstreamPage.tsx');
    expect(page).toMatch(/useBroughtIn\(workstream \? leadOf\(workstream\) : null\)/);
    expect(page).toMatch(/actions=\{broughtIn && <BroughtInPill rollup=\{broughtIn\} \/>\}/);
    // The pill is the one request pill, at its compact size: no second design.
    const pill = source('components/BroughtInRequests.tsx');
    expect(pill).toMatch(/<PullRequestSummary compact /);
    // The session's hover card lists them as children of its own request, from the same entry.
    const card = source('components/CardRequests.tsx');
    expect(card).toMatch(/useBroughtIn\(sessionId\)/);
    expect(source('components/SessionCard.tsx')).toMatch(/<RequestLines sessionId=\{session\.id\} withOwn \/>/);
    // Nothing computes it per row: only the store's one index calls the builder.
    for (const text of [header, row, page, card]) expect(text).not.toMatch(/broughtInRequests\(|broughtInByLead\(/);
  });
});

describe('what a phone reads', () => {
  it('carries the same roll-up, worked out on the desk, and while the desk is away only for sessions it holds', async () => {
    const { pullRequestsAnswer, heldPullRequests } = await import('./connect-lists.ts');
    const sessions = state.sessions.map((s) => ({ ...s, state: 'done' as const, note: '' }));
    const answer = pullRequestsAnswer(sessions, lookups, DEFAULT_ATTENTION_PREFS, state);
    expect(answer.broughtIn?.lead).toEqual(broughtInRequests('lead', state, lookupOf));
    const held = heldPullRequests(answer, new Set(['lead', 'a', 'b']));
    expect(held.broughtIn?.lead?.requests.map((r) => r.pr.number)).toEqual([11, 12]);
    expect(held.broughtIn?.c).toBeUndefined();
    // A desk with no workstreams or links to give says nothing brought in.
    expect(pullRequestsAnswer(sessions, lookups, DEFAULT_ATTENTION_PREFS).broughtIn).toEqual({});
  });
});
