// The Pull requests page's pure logic: one entry per request however many sessions link it, the
// minimal entry for a host that could not be asked, the filters and their counts, and the grouping.
import { describe, expect, it } from 'vitest';
import type { PullRequest } from './details.ts';
import {
  ARCHIVED_REQUEST_KEEP_MS,
  countRequests,
  groupByProject,
  isWorkspaceRequests,
  keptAfterArchive,
  matchesRequestFilter,
  mergeSessionRequests,
  minimalRequest,
  minimalRequests,
  needsAttention,
  requestFilterChips,
  sessionsByLinkTime,
  unaskedProjects,
  type ListedRequest,
  type SessionRequests,
} from './pull-request-list.ts';

const pr = (number: number, more: Partial<PullRequest> = {}): PullRequest => ({ number, title: `PR ${number}`, state: 'open', checks: 'none', review: 'none', url: `https://h/pull/${number}`, ...more });
const session = (id: string) => ({ id, title: `Session ${id}` });
const from = (id: string, prs: PullRequest[], more: Partial<SessionRequests> = {}): SessionRequests => ({ projectId: 'p', session: session(id), host: 'github', pullRequests: prs, minimal: false, ...more });
const listed = (p: PullRequest, projectId: string | null = 'p'): ListedRequest => ({ projectId, host: 'github', pullRequest: p, sessions: [session('s')], minimal: false });

describe('one entry per request', () => {
  it('names every session linked to the same request, once each', () => {
    const merged = mergeSessionRequests([from('a', [pr(1), pr(2)]), from('b', [pr(2)]), from('a', [pr(2)])]);
    expect(merged.map((r) => [r.pullRequest.number, r.sessions.map((s) => s.id)])).toEqual([
      [2, ['a', 'b']],
      [1, ['a']],
    ]);
  });

  it('keeps the same number in two projects or on two hosts apart', () => {
    const merged = mergeSessionRequests([from('a', [pr(5)]), from('b', [pr(5)], { projectId: 'q' }), from('c', [pr(5)], { host: 'gitlab' })]);
    expect(merged).toHaveLength(3);
  });

  it('prefers a looked-up copy over a minimal one, whichever came first', () => {
    const merged = mergeSessionRequests([from('a', [minimalRequest({ number: 7, url: 'u', state: 'open' })], { minimal: true }), from('b', [pr(7, { title: 'Real' })])]);
    expect(merged).toEqual([{ projectId: 'p', host: 'github', pullRequest: pr(7, { title: 'Real' }), sessions: [session('a'), session('b')], minimal: false }]);
    const kept = mergeSessionRequests([from('b', [pr(7, { title: 'Real' })]), from('a', [minimalRequest({ number: 7, url: 'u' })], { minimal: true })]);
    expect(kept[0]!.pullRequest.title).toBe('Real');
    expect(kept[0]!.minimal).toBe(false);
  });
});

describe('the first session', () => {
  it('is the one linked first; one with no stored link, or a tie, keeps its place', () => {
    const entry: ListedRequest = { projectId: 'p', host: 'github', pullRequest: pr(4), sessions: [session('late'), session('none'), session('early')], minimal: false };
    const links = [
      { sessionId: 'late', host: 'github' as const, number: 4, linkedAt: 20 },
      { sessionId: 'early', host: 'github' as const, number: 4, linkedAt: 10 },
      { sessionId: 'none', host: 'gitlab' as const, number: 4, linkedAt: 1 },
    ];
    expect(sessionsByLinkTime([entry], links)[0]!.sessions.map((s) => s.id)).toEqual(['early', 'late', 'none']);
    expect(entry.sessions.map((s) => s.id)).toEqual(['late', 'none', 'early']);
  });
});

describe('a host that could not be asked', () => {
  it('turns stored links into minimal entries: number, link and last-seen state, no title', () => {
    expect(minimalRequest({ number: 3, url: 'https://h/3', state: 'merged' })).toEqual({ number: 3, title: '', state: 'merged', checks: 'none', review: 'none', url: 'https://h/3' });
    expect(minimalRequest({ number: 3, url: 'https://h/3' }).state).toBe('open');
  });

  it('groups a session\'s links by host', () => {
    const links = [
      { host: 'github' as const, number: 1, url: 'a', branch: 'x', linkedAt: 0 },
      { host: 'gitlab' as const, number: 2, url: 'b', branch: 'x', linkedAt: 0, state: 'draft' as const },
    ];
    expect(minimalRequests('p', session('s'), links).map((r) => [r.host, r.minimal, r.pullRequests.map((p) => p.number)])).toEqual([
      ['github', true, [1]],
      ['gitlab', true, [2]],
    ]);
  });

  it('keeps one reason per project, the first', () => {
    expect(unaskedProjects([{ projectId: 'p', reason: 'one' }, { projectId: 'q', reason: 'two' }, { projectId: 'p', reason: 'three' }])).toEqual([
      { projectId: 'p', reason: 'one' },
      { projectId: 'q', reason: 'two' },
    ]);
  });
});

describe('the filters', () => {
  const failing = pr(1, { checks: 'failing' });
  const changes = pr(2, { review: 'changes-requested' });
  const conflicts = pr(3, { readiness: 'conflicts' });
  const behind = pr(4, { readiness: 'behind' });
  const blocked = pr(5, { readiness: 'blocked' });
  const ready = pr(6, { readiness: 'ready', checks: 'passing' });
  const plain = pr(7);
  const draft = pr(8, { state: 'draft', checks: 'failing' });
  const merged = pr(9, { state: 'merged' });
  const closed = pr(10, { state: 'closed', checks: 'failing' });
  const all = [failing, changes, conflicts, behind, blocked, ready, plain, draft, merged, closed];

  it('needs attention: open, not a draft, and checks failing, changes requested, conflicts, behind or blocked', () => {
    expect(all.filter(needsAttention).map((p) => p.number)).toEqual([1, 2, 3, 4, 5]);
  });

  it('sorts each request into the chips it belongs to', () => {
    const numbers = (f: Parameters<typeof matchesRequestFilter>[1]) => all.filter((p) => matchesRequestFilter(p, f)).map((p) => p.number);
    expect(numbers('open')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(numbers('ready')).toEqual([6]);
    expect(numbers('draft')).toEqual([8]);
    expect(numbers('finished')).toEqual([9, 10]);
  });

  it('counts each chip, in the page\'s order', () => {
    expect(requestFilterChips(countRequests(all.map((p) => listed(p))))).toEqual([
      { key: 'open', label: 'Open', count: 8 },
      { key: 'attention', label: 'Needs attention', count: 5 },
      { key: 'ready', label: 'Ready to merge', count: 1 },
      { key: 'draft', label: 'Draft', count: 1 },
      { key: 'finished', label: 'Merged/closed', count: 2 },
    ]);
  });
});

describe('grouping by project', () => {
  it('follows the sidebar order, then projects it does not list, then no project; empty groups left out', () => {
    const requests = [listed(pr(1), 'b'), listed(pr(2), null), listed(pr(3), 'z'), listed(pr(4), 'a'), listed(pr(5, { state: 'merged' }), 'c')];
    expect(groupByProject(requests, 'open', ['a', 'b', 'c']).map((g) => [g.projectId, g.requests.map((r) => r.pullRequest.number)])).toEqual([
      ['a', [4]],
      ['b', [1]],
      ['z', [3]],
      [null, [2]],
    ]);
    expect(groupByProject(requests, 'finished', ['a', 'b', 'c']).map((g) => g.projectId)).toEqual(['c']);
  });
});

describe('checking the answer', () => {
  it('accepts the route\'s shape and refuses anything else', () => {
    expect(isWorkspaceRequests({ requests: [listed(pr(1))], unasked: [{ projectId: null, reason: 'x' }] })).toBe(true);
    expect(isWorkspaceRequests({ requests: [{ ...listed(pr(1)), sessions: [] }], unasked: [] })).toBe(false);
    expect(isWorkspaceRequests({ requests: [] })).toBe(false);
    expect(isWorkspaceRequests(null)).toBe(false);
  });
});

describe('requests of archived sessions', () => {
  const day = 24 * 60 * 60 * 1000;
  it('are kept for a week after the session last did something', () => {
    const now = 100 * day;
    const sessions = [
      { id: 'fresh', updatedAt: now - day },
      { id: 'edge', updatedAt: now - ARCHIVED_REQUEST_KEEP_MS },
      { id: 'old', updatedAt: now - 8 * day },
      { id: 'active', updatedAt: now - 30 * day, lastActivityAt: now - 2 * day },
    ];
    expect(keptAfterArchive(sessions, now).map((s) => s.id)).toEqual(['fresh', 'edge', 'active']);
    expect(ARCHIVED_REQUEST_KEEP_MS).toBe(7 * day);
  });
});

