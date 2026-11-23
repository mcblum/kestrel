import { describe, expect, it } from 'vitest';
import { foldRows, QUIET_AFTER, type FoldItem } from './sidebar-fold.ts';

const NOW = 10 * QUIET_AFTER;
const row = (id: string, dot: FoldItem['dot'] = 'none', ago = 0): FoldItem => ({ id, dot, activityAt: NOW - ago });
const ids = (rows: readonly FoldItem[]) => rows.map((r) => r.id);

describe('foldRows', () => {
  it('moves the sessions that need the user to the top and keeps the rest in order', () => {
    const { shown } = foldRows([row('a'), row('b', 'needs-you'), row('c', 'unread')], { now: NOW, activeId: null });
    expect(ids(shown)).toEqual(['b', 'a', 'c']);
  });

  it('folds a session that has been quiet for a day once five newer ones exist, unless it is the open one', () => {
    const recent = ['a', 'b', 'c', 'd', 'e'].map((id) => row(id));
    const { shown, folded } = foldRows([...recent, row('old', 'none', QUIET_AFTER), row('open', 'none', 3 * QUIET_AFTER)], { now: NOW, activeId: 'open', limit: 10 });
    expect(ids(shown)).toEqual(['a', 'b', 'c', 'd', 'e', 'open']);
    expect(ids(folded)).toEqual(['old']);
  });

  it('always shows the five newest, however long ago they were, and folds the older ones', () => {
    // A computer not used for days: every session is quiet.
    const rows = [1, 2, 3, 4, 5, 6, 7].map((n) => row(`s${n}`, 'none', (n + 2) * QUIET_AFTER));
    const { shown, folded } = foldRows(rows, { now: NOW, activeId: null });
    expect(ids(shown)).toEqual(['s1', 's2', 's3', 's4', 's5']);
    expect(ids(folded)).toEqual(['s6', 's7']);
  });

  it('keeps the user\'s order while choosing the newest by activity', () => {
    const rows = [row('oldest', 'none', 9 * QUIET_AFTER), ...[1, 2, 3, 4, 5].map((n) => row(`s${n}`, 'none', (n + 2) * QUIET_AFTER))];
    const { shown, folded } = foldRows(rows, { now: NOW, activeId: null });
    expect(ids(shown)).toEqual(['s1', 's2', 's3', 's4', 's5']);
    expect(ids(folded)).toEqual(['oldest']);
  });

  it('never folds an old session that has something new, or one at work', () => {
    const { folded } = foldRows([row('u', 'unread', 5 * QUIET_AFTER), row('w', 'working', 5 * QUIET_AFTER)], { now: NOW, activeId: null });
    expect(folded).toEqual([]);
  });

  it('shows only the first few of the rest, but every one that needs the user', () => {
    const rows = [...['a', 'b', 'c', 'd'].map((id) => row(id)), row('n1', 'needs-you'), row('n2', 'needs-you')];
    const { shown, folded } = foldRows(rows, { now: NOW, activeId: null, limit: 3 });
    expect(ids(shown)).toEqual(['n1', 'n2', 'a']);
    expect(ids(folded)).toEqual(['b', 'c', 'd']);
  });
});
