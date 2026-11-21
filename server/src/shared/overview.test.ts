import { describe, expect, it } from 'vitest';
import type { SessionView } from '../model.ts';
import { activityGarden, RECENT_DONE, overviewSection, overviewSections, showsStatus } from './overview.ts';

type Row = Pick<SessionView, 'id' | 'state' | 'note' | 'landedIn' | 'request' | 'updatedAt'>;
const row = (id: string, over: Partial<Row> = {}): Row => ({ id, state: 'done', note: '', landedIn: null, request: null, updatedAt: 10, ...over });

describe('which Overview section a session is in', () => {
  it('puts a finished session the user has not looked at under Unread', () => {
    expect(overviewSection(row('a', { updatedAt: 10 }), { a: 5 })).toBe('unread');
    expect(overviewSection(row('a', { updatedAt: 10 }), {})).toBe('unread');
  });

  it('moves it to Recently done once it was looked at', () => {
    expect(overviewSection(row('a', { updatedAt: 10 }), { a: 10 })).toBe('done');
  });

  it('counts nothing unread before the first run has recorded what exists', () => {
    expect(overviewSection(row('a'), null)).toBe('done');
  });

  it('keeps waiting and running sessions in their own sections, looked at or not', () => {
    expect(overviewSection(row('a', { state: 'attention' }), {})).toBe('needs-you');
    expect(overviewSection(row('a', { state: 'attention', note: 'Failed · boom' }), {})).toBe('needs-you');
    expect(overviewSection(row('a', { state: 'running' }), {})).toBe('working');
  });

  it('lists unread work to review, or interrupted, under Unread; read, under its own status', () => {
    expect(overviewSection(row('a', { request: 'open' }), {})).toBe('unread');
    expect(overviewSection(row('a', { request: 'open' }), { a: 10 })).toBe('review');
    expect(overviewSection(row('a', { state: 'interrupted' }), {})).toBe('unread');
    expect(overviewSection(row('a', { state: 'interrupted' }), { a: 10 })).toBe('interrupted');
  });

  it('lists a read session whose work changed something but whose request is not open under Recently done', () => {
    expect(overviewSection(row('a', { landedIn: 'p' }), { a: 10 })).toBe('done');
    for (const request of ['merged', 'closed', 'draft'] as const) expect(overviewSection(row('a', { landedIn: 'p', request }), { a: 10 })).toBe('done');
  });
});

describe('the Overview sections', () => {
  it('lists each session once, needs you longest waiting first, the rest newest first', () => {
    const sessions = [row('n1', { state: 'attention', updatedAt: 5 }), row('n2', { state: 'attention', updatedAt: 1 }), row('u1', { updatedAt: 3 }), row('u2', { updatedAt: 8 }), row('d1', { updatedAt: 4 }), row('w', { state: 'running' })];
    const { rows, counts } = overviewSections(sessions, { d1: 4, u1: 1, u2: 2 });
    expect(rows['needs-you'].map((s) => s.id)).toEqual(['n2', 'n1']);
    expect(rows.unread.map((s) => s.id)).toEqual(['u2', 'u1']);
    expect(rows.done.map((s) => s.id)).toEqual(['d1']);
    expect(rows.working.map((s) => s.id)).toEqual(['w']);
    expect(counts).toEqual({ 'needs-you': 2, unread: 2, working: 1, review: 0, interrupted: 0, done: 1 });
  });

  it('shows the newest few done and counts them all', () => {
    const done = Array.from({ length: RECENT_DONE + 2 }, (_, i) => row(`d${i}`, { updatedAt: i }));
    const seen = Object.fromEntries(done.map((s) => [s.id, s.updatedAt]));
    const { rows, counts } = overviewSections(done, seen);
    expect(rows.done).toHaveLength(RECENT_DONE);
    expect(rows.done[0]!.id).toBe(`d${RECENT_DONE + 1}`);
    expect(counts.done).toBe(RECENT_DONE + 2);
  });
});

describe('the Status column of a section', () => {
  it('is left out when every row would say the same', () => {
    expect(showsStatus([row('a'), row('b')])).toBe(false);
    expect(showsStatus([row('a', { state: 'running' }), row('b', { state: 'running' })])).toBe(false);
    expect(showsStatus([])).toBe(false);
  });

  it('is kept when rows differ', () => {
    expect(showsStatus([row('a'), row('b', { request: 'open' })])).toBe(true);
    expect(showsStatus([row('a'), row('b', { landedIn: 'p' })])).toBe(false);
  });
});

describe('activity garden', () => {
  it('keeps exactly thirty local days ending today, including empty days', () => {
    const now = new Date(2026, 10, 18, 12);
    const { days } = activityGarden([], now);
    expect(days).toHaveLength(30);
    expect(days[0]!.key).toBe('2026-10-20');
    expect(days[29]!.key).toBe('2026-11-18');
    expect(new Set(days.map(d => d.key)).size).toBe(30);
  });

  it('counts a completed session once, excludes missing and future timestamps, and separates local days', () => {
    const now = new Date(2026, 10, 18, 12);
    const a = { id: 'a', completedAt: new Date(2026, 10, 18, 0, 1).getTime() };
    const { days, total } = activityGarden([a, a, { id: 'b', completedAt: new Date(2026, 10, 17, 23, 59).getTime() }, { id: 'running' }, { id: 'future', completedAt: now.getTime() + 1 }, { id: 'old', completedAt: new Date(2026, 9, 19).getTime() }], now);
    expect(total).toBe(2);
    expect(days.find(d => d.key === '2026-11-18')?.sessions.map(s => s.id)).toEqual(['a']);
    expect(days.find(d => d.key === '2026-11-17')?.sessions.map(s => s.id)).toEqual(['b']);
    expect(days.find(d => d.key === '2026-10-19')).toBeUndefined();
  });
});
