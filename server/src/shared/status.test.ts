import { describe, expect, it } from 'vitest';
import type { SessionView } from '../model.ts';
import { DEFAULT_SORT, NO_FILTERS, STATUS_LABEL, applyFilters, countByFilter, emptyState, filterChips, hasFilters, inView, isFailureNote, matchesFilter, overviewLine, sortSessions, statusLabel, statusOf, tagDot, workstreamDots, tagSessionIds } from './status.ts';

let n = 0;
const s = (over: Partial<SessionView> = {}): SessionView => ({
  id: `s${++n}`, title: `Session ${n}`, agent: 'claude', state: 'done', note: '', startedIn: 'p1', startedFolderId: null, folderId: null, landedIn: null, worktreePath: null, branch: null, worktreeDiscarded: false, groupId: null, createdAt: n, updatedAt: n,
  filing: { projectId: 'p1', status: 'started', discarded: false }, tags: [], request: null, ...over,
});

describe('the one status vocabulary', () => {
  it('uses exactly these words', () => {
    expect(STATUS_LABEL).toEqual({ 'needs-you': 'Needs you', working: 'Working', review: 'Ready to review', done: 'Done', stopped: 'Stopped', interrupted: 'Interrupted', failed: 'Failed' });
  });
  it('maps every session state', () => {
    expect(statusOf({ state: 'running', note: 'Working…' })).toBe('working');
    expect(statusOf({ state: 'attention', note: 'Needs you · Write x' })).toBe('needs-you');
    expect(statusOf({ state: 'interrupted', note: '' })).toBe('interrupted');
  });
  it('an open request does not change a session that is not finished', () => {
    expect(statusOf({ state: 'running', note: 'Working…', request: 'open' })).toBe('working');
    expect(statusOf({ state: 'attention', note: 'Needs you · x', request: 'open' })).toBe('needs-you');
    expect(statusOf({ state: 'interrupted', note: '', request: 'open' })).toBe('interrupted');
  });
  it('a finished session is Ready to review only when its newest request is open', () => {
    expect(statusOf({ state: 'done', note: 'Finished', request: 'open' })).toBe('review');
    expect(statusLabel(s({ state: 'done', request: 'open' }))).toBe('Ready to review');
  });
  it('a finished session whose work changed something but has no request is Done', () => {
    expect(statusOf(s({ state: 'done', landedIn: 'p1', filing: { projectId: 'p1', status: 'landed', discarded: false } }))).toBe('done');
    expect(statusOf({ state: 'done', note: 'Finished' })).toBe('done');
    expect(statusOf({ state: 'done', note: 'Finished', request: null })).toBe('done');
  });
  it('a finished session whose newest request is merged, closed or a draft is Done', () => {
    expect(statusOf({ state: 'done', note: 'Finished', request: 'merged' })).toBe('done');
    expect(statusOf({ state: 'done', note: 'Finished', request: 'closed' })).toBe('done');
    expect(statusOf({ state: 'done', note: 'Finished', request: 'draft' })).toBe('done');
  });
  it('a session that handed off is Done even with an open request', () => {
    expect(statusLabel({ state: 'done', note: 'Handed off', request: 'open' })).toBe('Done');
  });
  it('a failed run is Failed, a kind of Needs you', () => {
    expect(isFailureNote('Failed · boom')).toBe(true);
    expect(isFailureNote('Claude is not signed in')).toBe(true);
    expect(isFailureNote('Needs you · Failed to parse')).toBe(false);
    expect(statusOf({ state: 'attention', note: 'Failed · boom' })).toBe('failed');
    expect(matchesFilter(s({ state: 'attention', note: 'Failed · boom' }), 'needs-you')).toBe(true);
  });
});

describe('filters', () => {
  const list = [s({ state: 'attention', note: 'Needs you · x' }), s({ state: 'attention', note: 'Failed · y' }), s({ state: 'running' }), s({ state: 'done', request: 'open' }), s({ state: 'done', landedIn: 'p1' })];
  it('count each chip once', () => {
    expect(countByFilter(list)).toEqual({ all: 5, 'needs-you': 2, working: 1, review: 1, done: 1, interrupted: 0 });
  });
  it('show Interrupted only when something is', () => {
    expect(filterChips(countByFilter(list)).map((c) => c.label)).toEqual(['All', 'Needs you', 'Working', 'Ready to review', 'Done']);
    expect(filterChips(countByFilter([...list, s({ state: 'interrupted' })])).map((c) => c.label)).toContain('Interrupted');
  });
  it('apply the chip and the search together', () => {
    const named = [s({ title: 'Fix login', state: 'running' }), s({ title: 'Fix billing', state: 'done' }), s({ title: 'Docs', state: 'running' })];
    const hay = (x: SessionView) => x.title;
    expect(applyFilters(named, { status: 'working', query: 'fix' }, hay).map((x) => x.title)).toEqual(['Fix login']);
    expect(applyFilters(named, NO_FILTERS, hay)).toHaveLength(3);
    expect(hasFilters({ status: 'all', query: '  ' })).toBe(false);
    expect(hasFilters({ status: 'done', query: '' })).toBe(true);
  });
});

describe('sorting', () => {
  const a = s({ title: 'b', updatedAt: 10, state: 'done' });
  const b = s({ title: 'a', updatedAt: 30, state: 'attention', note: 'Needs you · q' });
  const c = s({ title: 'c', updatedAt: 20, state: 'running' });
  const project = (x: SessionView) => (x === a ? 'zeta' : 'alpha');
  it('sorts by each column in either direction, ties by recency', () => {
    expect(sortSessions([a, b, c], DEFAULT_SORT, project).map((x) => x.title)).toEqual(['a', 'c', 'b']);
    expect(sortSessions([a, b, c], { key: 'session', dir: 'asc' }, project).map((x) => x.title)).toEqual(['a', 'b', 'c']);
    expect(sortSessions([a, b, c], { key: 'status', dir: 'asc' }, project).map((x) => x.title)).toEqual(['a', 'c', 'b']);
    expect(sortSessions([a, b, c], { key: 'project', dir: 'asc' }, project).map((x) => x.title)).toEqual(['a', 'c', 'b']);
    expect(sortSessions([a, b, c], { key: 'project', dir: 'desc' }, project).map((x) => x.title)).toEqual(['b', 'a', 'c']);
  });
  it('does not change the input', () => {
    const input = [a, b, c];
    sortSessions(input, DEFAULT_SORT, project);
    expect(input).toEqual([a, b, c]);
  });
});

describe('which sessions a destination lists', () => {
  const hidden = s({ filing: { projectId: null, status: 'hidden', discarded: false } });
  const mine = s({ groupId: 'g1', filing: { projectId: 'p1', status: 'landed', discarded: false } });
  const nowhere = s({ startedIn: null, filing: { projectId: null, status: 'unscoped', discarded: false } });
  it('leaves a handed-off parent out of project, attention and overview views, but not out of its folder', () => {
    expect(inView(hidden, { kind: 'project', id: 'p1' })).toBe(false);
    expect(inView(hidden, { kind: 'overview' })).toBe(false);
    expect(inView({ ...hidden, groupId: 'g1' }, { kind: 'group', id: 'g1' })).toBe(true);
    expect(inView(mine, { kind: 'project', id: 'p1' })).toBe(true);
    expect(inView(nowhere, { kind: 'unscoped' })).toBe(true);
    expect(inView({ ...mine, state: 'attention' }, { kind: 'attention' })).toBe(true);
  });
  it('lists every session with a tag on its page, in any case, even a handed-off parent', () => {
    expect(inView({ ...hidden, tags: ['PLAT-1234'] }, { kind: 'tag', id: 'plat-1234' })).toBe(true);
    expect(inView({ ...mine, tags: ['infra'] }, { kind: 'tag', id: 'PLAT-1234' })).toBe(false);
  });
});

describe('empty states', () => {
  const base = { shown: 0, unfiltered: 0, projects: 1, sessions: 0 };
  it('is the first-session experience on Overview whenever there are no sessions, with or without projects', () => {
    expect(emptyState({ ...base, view: 'overview', projects: 0 })).toBe('first-session');
    expect(emptyState({ ...base, view: 'overview', projects: 3 })).toBe('first-session');
  });
  it('is the established "nothing needs you" state only once sessions exist', () => {
    expect(emptyState({ ...base, view: 'overview', projects: 0, sessions: 2 })).toBe('overview');
    expect(emptyState({ ...base, view: 'attention', sessions: 2 })).toBe('attention');
    expect(emptyState({ ...base, view: 'attention', sessions: 0 })).toBe('list');
  });
  it('picks one message per destination', () => {
    expect(emptyState({ ...base, view: 'project' })).toBe('project');
    expect(emptyState({ ...base, view: 'group' })).toBe('folder');
    expect(emptyState({ ...base, sessions: 1, view: 'attention' })).toBe('attention');
    expect(emptyState({ ...base, view: 'all' })).toBe('list');
    expect(emptyState({ ...base, view: 'unscoped' })).toBe('list');
  });
  it('blames the filters when the view has sessions that the filters hide', () => {
    expect(emptyState({ ...base, view: 'project', unfiltered: 3 })).toBe('filtered');
    expect(emptyState({ ...base, view: 'overview', unfiltered: 3, projects: 0, sessions: 3 })).toBe('filtered');
  });
  it('is nothing when there are rows', () => {
    expect(emptyState({ ...base, view: 'project', shown: 1, unfiltered: 3 })).toBeNull();
  });
});

describe('the Overview line', () => {
  it('says what to do next, in the vocabulary', () => {
    expect(overviewLine({ 'needs-you': 2, working: 4, review: 1 })).toBe('Two sessions need your input.');
    expect(overviewLine({ 'needs-you': 1, working: 0, review: 0 })).toBe('One session needs your input.');
    expect(overviewLine({ 'needs-you': 0, working: 4, review: 1 })).toBe('Four sessions are working. Nothing needs your input.');
    expect(overviewLine({ 'needs-you': 0, working: 0, review: 3 })).toBe('Three sessions are ready to review.');
    expect(overviewLine({ 'needs-you': 0, working: 0, review: 0 })).toBe('Nothing needs your input.');
    expect(overviewLine({ 'needs-you': 12, working: 0, review: 0 })).toBe('12 sessions need your input.');
  });
  it('mentions unread results when nothing needs input', () => {
    expect(overviewLine({ 'needs-you': 0, working: 3, review: 1, unread: 2 })).toBe('Nothing needs your input. Two sessions have results you have not read.');
    expect(overviewLine({ 'needs-you': 0, working: 0, review: 0, unread: 1 })).toBe('Nothing needs your input. One session has results you have not read.');
    expect(overviewLine({ 'needs-you': 1, working: 0, review: 0, unread: 4 })).toBe('One session needs your input.');
    expect(overviewLine({ 'needs-you': 0, working: 0, review: 0, unread: 0 })).toBe('Nothing needs your input.');
  });
});

describe('the sessions under a tag in the sidebar', () => {
  it('lists every session carrying the tag in any case, flat, most recently updated first', () => {
    const old = s({ id: 'old', tags: ['PLAT-1'], updatedAt: 5 });
    const child = s({ id: 'child', tags: ['plat-1'], updatedAt: 9, groupId: 'g1' });
    const parked = s({ id: 'parked', tags: ['Plat-1'], updatedAt: 7, filing: { projectId: null, status: 'hidden', discarded: false } });
    const other = s({ id: 'other', tags: ['infra'], updatedAt: 99 });
    expect(tagSessionIds([old, child, parked, other], 'PLAT-1')).toEqual(['child', 'parked', 'old']);
    expect(tagSessionIds([other], 'PLAT-1')).toEqual([]);
  });
});

describe('the dot on a tag in the sidebar', () => {
  const waiting = s({ id: 'w', tags: ['plat-1'], state: 'attention', note: 'Needs you · q', updatedAt: 3 });
  const finished = s({ id: 'f', tags: ['PLAT-1'], state: 'done', updatedAt: 9 });
  const busy = s({ id: 'b', tags: ['plat-1'], state: 'running', updatedAt: 4 });
  const elsewhere = s({ id: 'x', tags: ['infra'], state: 'attention', updatedAt: 5 });
  it('is yellow when any session with the tag needs the user, whatever else is unread', () => {
    expect(tagDot([waiting, finished, busy], 'Plat-1', {})).toBe('needs-you');
  });
  it('is green when one finished since it was last looked at, and nothing needs the user', () => {
    expect(tagDot([finished, busy], 'plat-1', { f: 8 })).toBe('unread');
  });
  it('shows nothing for working or already-read sessions, nor for sessions with other tags', () => {
    expect(tagDot([finished, busy, elsewhere], 'plat-1', { f: 9 })).toBe('none');
    expect(tagDot([finished], 'plat-1', null)).toBe('none');
  });
});

describe('the dots on a workstream\'s top row', () => {
  const lead = s({ id: 'lead', state: 'done', updatedAt: 3 });
  const busy = s({ id: 'busy', state: 'running', updatedAt: 4 });
  const busyToo = s({ id: 'busy2', state: 'running', updatedAt: 4 });
  const finished = s({ id: 'fin', state: 'done', updatedAt: 9 });
  const waiting = s({ id: 'wait', state: 'attention', updatedAt: 5 });
  const outside = s({ id: 'out', state: 'attention', updatedAt: 5 });
  const all = [lead, busy, busyToo, finished, waiting, outside];
  const seen = { lead: 3, fin: 8 };

  it('folded: one dot for each kind of state among its sessions, least complete first', () => {
    expect(workstreamDots(all, ['lead', 'busy', 'fin'], 'lead', true, seen)).toEqual(['working', 'unread']);
    expect(workstreamDots(all, ['lead', 'fin', 'wait', 'busy'], 'lead', true, seen)).toEqual(['working', 'needs-you', 'unread']);
  });
  it('folded: each kind once however many sessions are in it, and nothing for sessions it does not point at', () => {
    expect(workstreamDots(all, ['lead', 'busy', 'busy2'], 'lead', true, seen)).toEqual(['working']);
  });
  it('folded: the lead\'s own state counts', () => {
    expect(workstreamDots(all, ['lead', 'busy'], 'lead', true, {})).toEqual(['working', 'unread']);
  });
  it('folded: nothing when every session has been read and none is busy', () => {
    expect(workstreamDots(all, ['lead', 'fin'], 'lead', true, { lead: 3, fin: 9 })).toEqual([]);
    expect(workstreamDots(all, ['lead', 'fin'], 'lead', true, null)).toEqual([]);
  });
  it('unfolded: only the lead\'s dot, since every other session shows its own under it', () => {
    expect(workstreamDots(all, ['lead', 'busy', 'wait'], 'lead', false, seen)).toEqual([]);
    expect(workstreamDots(all, ['lead', 'busy', 'wait'], 'lead', false, {})).toEqual(['unread']);
    expect(workstreamDots(all, ['busy', 'wait'], null, false, seen)).toEqual([]);
  });
});
