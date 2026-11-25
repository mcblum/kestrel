// The Code reviews page's filters: who asked, where, how recently, and the text search.
import { describe, expect, it } from 'vitest';
import { asReviewSort, DEFAULT_REVIEW_SORT, filterReviews, isFiltering, matchesText, NO_REVIEW_FILTERS, placeChoices, placeOf, sortReviews, splitStarted, whoChoices, type ReviewFilters } from './review-filter.ts';

const HOUR = 3_600_000;
const now = 1_800_000_000_000;
const names = (id: string) => ({ p1: 'Storefront' })[id];
const request = (number: number, over: Record<string, unknown> = {}) => ({ host: 'github' as const, number, repository: 'acme/app', title: `Change ${number}`, author: 'sam', projectId: null, updatedAt: now, ...over });
const rows = [
  request(1, { title: 'Retry failed webhook deliveries', requestedBy: 'devon', projectId: 'p1', openedAt: now - 20 * 60_000 }),
  request(2, { title: 'Keep the header in view', author: 'jonas', repository: 'acme/design-system', openedAt: now - 5 * HOUR }),
  request(3, { title: 'Write the export as Parquet', author: 'Amara', repository: 'acme/billing', openedAt: now - 4 * 24 * HOUR }),
  request(4, { title: 'Pin the base image', author: 'jonas', repository: 'acme/infra', updatedAt: now - 40 * 24 * HOUR }),
];
const numbers = (filters: Partial<ReviewFilters>) => filterReviews(rows, { ...NO_REVIEW_FILTERS, ...filters }, names, now).map((r) => r.number);

describe('filtering by what other reviewers said', () => {
  const said = (approvedBy: string[], changesRequestedBy: string[], satisfied: boolean) => ({ others: { approvedBy, changesRequestedBy, satisfied } });
  const reviewed = [request(1, said(['dana'], [], true)), request(2, said(['dana'], [], false)), request(3, said([], ['kim'], false)), request(4), request(5, said([], [], false))];
  const shown = (approval: ReviewFilters['approval']) => filterReviews(reviewed, { ...NO_REVIEW_FILTERS, approval }, names, now).map((r) => r.number);

  it('by the one rule othersSaid sorts them by', () => {
    expect(shown('any')).toEqual([1, 2, 3, 4, 5]);
    expect(shown('satisfied')).toEqual([1]);
    expect(shown('approved')).toEqual([2]);
    expect(shown('changes')).toEqual([3]);
    expect(shown('none')).toEqual([4, 5]);
    expect(isFiltering({ ...NO_REVIEW_FILTERS, approval: 'satisfied' })).toBe(true);
  });
});

describe('filtering the Code reviews page', () => {
  it('shows everything until a filter is set', () => {
    expect(numbers({})).toEqual([1, 2, 3, 4]);
    expect(isFiltering(NO_REVIEW_FILTERS)).toBe(false);
    expect(isFiltering({ ...NO_REVIEW_FILTERS, text: '  ' })).toBe(false);
    expect(isFiltering({ ...NO_REVIEW_FILTERS, within: 'day' })).toBe(true);
  });

  it('by who asked: whoever requested the review, else its author', () => {
    expect(whoChoices(rows)).toEqual(['Amara', 'devon', 'jonas']);
    expect(numbers({ who: 'devon' })).toEqual([1]);
    expect(numbers({ who: 'jonas' })).toEqual([2, 4]);
  });

  it('by project, or by repository for a request in no project', () => {
    expect(placeOf(rows[0]!, names)).toBe('Storefront');
    expect(placeChoices(rows, names)).toEqual(['billing', 'design-system', 'infra', 'Storefront']);
    expect(numbers({ place: 'Storefront' })).toEqual([1]);
    expect(numbers({ place: 'infra' })).toEqual([4]);
  });

  it('by how recently it was opened, going by its last change when the host did not say', () => {
    expect(numbers({ within: 'hour' })).toEqual([1]);
    expect(numbers({ within: 'day' })).toEqual([1, 2]);
    expect(numbers({ within: 'week' })).toEqual([1, 2, 3]);
    expect(numbers({ within: 'month' })).toEqual([1, 2, 3]);
  });

  it('by text over the title, repository, project, number and people, every word needed', () => {
    expect(numbers({ text: 'webhook' })).toEqual([1]);
    expect(numbers({ text: 'STOREFRONT retry' })).toEqual([1]);
    expect(numbers({ text: '#3' })).toEqual([3]);
    expect(numbers({ text: 'jonas pin' })).toEqual([4]);
    expect(numbers({ text: 'jonas webhook' })).toEqual([]);
  });

  it('with every filter at once', () => {
    expect(numbers({ who: 'jonas', within: 'day', text: 'header' })).toEqual([2]);
  });
});

describe('the text search is forgiving', () => {
  it('finds a word with letters left out, or abbreviated', () => {
    expect(matchesText('Retry failed webhook deliveries', 'wbhk')).toBe(true);
    expect(matchesText('Retry failed webhook deliveries', 'delivries')).toBe(true);
    expect(matchesText('Write the export as Parquet', 'prqt')).toBe(true);
  });

  it('does not find letters scattered across words, or two-letter guesses', () => {
    expect(matchesText('Retry failed webhook deliveries', 'rfw')).toBe(false);
    expect(matchesText('Keep the header in view', 'kv')).toBe(false);
    expect(matchesText('Keep the header in view', 'zzz')).toBe(false);
  });
});

describe('the reviews the user has started come first', () => {
  it('as a group of their own, each group in the order given', () => {
    const list = [{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd' }];
    expect(splitStarted(list, new Set(['c', 'a']))).toEqual({ started: [{ key: 'a' }, { key: 'c' }], rest: [{ key: 'b' }, { key: 'd' }] });
    expect(splitStarted(list, new Set())).toEqual({ started: [], rest: list });
  });
});

describe('ordering the Code reviews page', () => {
  const r = (key: string, openedAt: number | undefined, updatedAt: number) => ({ key, updatedAt, ...(openedAt === undefined ? {} : { openedAt }) });
  // a: opened first, changed last. b: opened last, changed first. c: the host gave no opening date.
  const listed = [r('a', 100, 900), r('b', 300, 400), r('c', undefined, 200)];
  const keys = (by: 'activity' | 'opened', descending: boolean) => sortReviews(listed, { by, descending }).map((x) => x.key);

  it('by last activity or by date opened, newest or oldest first', () => {
    expect(keys('activity', true)).toEqual(['a', 'b', 'c']);
    expect(keys('activity', false)).toEqual(['c', 'b', 'a']);
    expect(keys('opened', true)).toEqual(['b', 'c', 'a']);
    expect(keys('opened', false)).toEqual(['a', 'c', 'b']);
  });

  it('settles a tie by key either way, and leaves the list it was given alone', () => {
    const tied = [r('z', 5, 5), r('y', 5, 5)];
    expect(sortReviews(tied, { by: 'opened', descending: true }).map((x) => x.key)).toEqual(['y', 'z']);
    expect(sortReviews(tied, { by: 'opened', descending: false }).map((x) => x.key)).toEqual(['y', 'z']);
    expect(tied.map((x) => x.key)).toEqual(['z', 'y']);
  });

  it('reads a stored sort, and the default for anything else', () => {
    expect(asReviewSort({ by: 'opened', descending: false })).toEqual({ by: 'opened', descending: false });
    expect(asReviewSort({ by: 'size', descending: true })).toEqual(DEFAULT_REVIEW_SORT);
    expect(asReviewSort(null)).toEqual(DEFAULT_REVIEW_SORT);
  });
});
