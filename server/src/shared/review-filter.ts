// The Code reviews page's filters: who asked, which project, how recently it was opened, what other
// reviewers said (Approved, `othersSaid`), and a
// forgiving text search over what a row shows; and the order its rows are listed in. Pure and browser-safe; `now` is passed in.
import { othersSaid, type OthersSaid } from './others-said.ts';
import { askedBy, repositoryName, requestNumberLabel, type ReviewRequest } from './review-requests.ts';

/** How recently: opened within the last hour, day, week or month; `any` is no limit. */
export type ReviewWithin = 'any' | 'hour' | 'day' | 'week' | 'month';

export const REVIEW_WITHIN: readonly ReviewWithin[] = ['any', 'hour', 'day', 'week', 'month'];

export const REVIEW_WITHIN_LABEL: Record<ReviewWithin, string> = { any: 'Any time', hour: 'Last hour', day: 'Last day', week: 'Last week', month: 'Last month' };

const HOUR_MS = 3_600_000;
const WITHIN_MS: Record<Exclude<ReviewWithin, 'any'>, number> = { hour: HOUR_MS, day: 24 * HOUR_MS, week: 7 * 24 * HOUR_MS, month: 30 * 24 * HOUR_MS };

/**
 * What other reviewers said, as `othersSaid` sorts it: the host says approved (`satisfied`), some
 * approved but not enough yet (`approved`), changes asked for (`changes`), nobody said anything
 * (`none`); `any` is no limit.
 */
export type ReviewApproval = 'any' | OthersSaid['kind'];

export const REVIEW_APPROVAL: readonly ReviewApproval[] = ['any', 'satisfied', 'approved', 'changes', 'none'];

export const REVIEW_APPROVAL_LABEL: Record<ReviewApproval, string> = { any: 'Any approvals', satisfied: 'Approved', approved: 'Some approvals', changes: 'Changes requested', none: 'No other reviews' };

export interface ReviewFilters {
  /** Who asked for the review (`askedBy`); empty for anyone. */
  who: string;
  /** The place a request is in (`placeOf`): a project's name, or a repository's; empty for any. */
  place: string;
  within: ReviewWithin;
  approval: ReviewApproval;
  text: string;
}

export const NO_REVIEW_FILTERS: ReviewFilters = { who: '', place: '', within: 'any', approval: 'any', text: '' };

export const isFiltering = (f: ReviewFilters): boolean => f.who !== '' || f.place !== '' || f.within !== 'any' || f.approval !== 'any' || f.text.trim() !== '';

type Listed = Pick<ReviewRequest, 'host' | 'number' | 'repository' | 'title' | 'author' | 'requestedBy' | 'projectId' | 'openedAt' | 'updatedAt' | 'others'>;

/** A project's name by its id; undefined when it is not registered. */
export type ProjectNames = (projectId: string) => string | undefined;

/** Where a request is, as its row says it: its project's name, or its repository's when it is in no project. */
export const placeOf = (request: Pick<Listed, 'projectId' | 'repository'>, names: ProjectNames): string => (request.projectId && names(request.projectId)) || repositoryName(request.repository);

/** When a request was opened; when it last changed where the host did not say. */
export const openedAtOf = (request: Pick<Listed, 'openedAt' | 'updatedAt'>): number => request.openedAt ?? request.updatedAt;

/** The values a select offers, each once, in alphabetical order whatever the case. */
const choices = (values: readonly string[]): string[] => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

/** Everyone who asked for one of these reviews. */
export const whoChoices = (requests: readonly Listed[]): string[] => choices(requests.map(askedBy));

/** Every project or repository one of these requests is in. */
export const placeChoices = (requests: readonly Listed[], names: ProjectNames): string[] => choices(requests.map((r) => placeOf(r, names)));

/** Whether `term`'s letters appear in `word` in order: "wbhk" in "webhook". */
function inOrder(term: string, word: string): boolean {
  let at = 0;
  for (const ch of word) if (ch === term[at]) at += 1;
  return at === term.length;
}

/**
 * Whether text matches a search: every word typed must be found. A word is found when it is part
 * of the text as typed, or when its letters appear in order inside one word of the text, so a
 * letter left out or an abbreviation still finds it. Case is ignored. Pure.
 */
export function matchesText(haystack: string, query: string): boolean {
  const text = haystack.toLowerCase();
  const words = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => text.includes(term) || (term.length >= 3 && words.some((word) => inOrder(term, word))));
}

/** What the text search reads of a request: its title, repository, project, number, author and who asked. */
export const searchText = (request: Listed, names: ProjectNames): string =>
  [request.title, request.repository, placeOf(request, names), requestNumberLabel(request), request.author, request.requestedBy ?? ''].join(' ');

/** The requests that pass every filter, in the order given. Pure. */
export function filterReviews<T extends Listed>(requests: readonly T[], filters: ReviewFilters, names: ProjectNames, now: number): T[] {
  const since = filters.within === 'any' ? null : now - WITHIN_MS[filters.within];
  return requests.filter(
    (r) =>
      (filters.who === '' || askedBy(r) === filters.who) &&
      (filters.place === '' || placeOf(r, names) === filters.place) &&
      (since === null || openedAtOf(r) >= since) &&
      (filters.approval === 'any' || othersSaid(r).kind === filters.approval) &&
      (filters.text.trim() === '' || matchesText(searchText(r, names), filters.text)),
  );
}

/** What the page's rows are ordered by: when the request last changed, or when it was opened. */
export type ReviewSortBy = 'activity' | 'opened';

export const REVIEW_SORT_BY: readonly ReviewSortBy[] = ['activity', 'opened'];

export const REVIEW_SORT_LABEL: Record<ReviewSortBy, string> = { activity: 'Last activity', opened: 'Date opened' };

export interface ReviewSort {
  by: ReviewSortBy;
  /** Newest first when true. */
  descending: boolean;
}

/** As the server lists them: most recently changed first. */
export const DEFAULT_REVIEW_SORT: ReviewSort = { by: 'activity', descending: true };

/** A stored sort, checked: whatever is not one reads as the default. */
export function asReviewSort(raw: unknown): ReviewSort {
  const given = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  if (!REVIEW_SORT_BY.includes(given.by as ReviewSortBy) || typeof given.descending !== 'boolean') return DEFAULT_REVIEW_SORT;
  return { by: given.by as ReviewSortBy, descending: given.descending };
}

/** What the direction button says it will show first, and is called. */
export const sortDirectionLabel = (sort: ReviewSort): string => (sort.descending ? 'Newest first' : 'Oldest first');

/** The requests in the order asked for; the key settles a tie, so the order never flickers. Pure. */
export function sortReviews<T extends Pick<ReviewRequest, 'key' | 'openedAt' | 'updatedAt'>>(requests: readonly T[], sort: ReviewSort): T[] {
  const when = (r: T): number => (sort.by === 'opened' ? openedAtOf(r) : r.updatedAt);
  const direction = sort.descending ? -1 : 1;
  return [...requests].sort((a, b) => direction * (when(a) - when(b)) || a.key.localeCompare(b.key));
}

/**
 * The page's two groups: the requests the user has a review of (a session reviews them), which is
 * what they took on, and the ones nobody has started. Each keeps the order given. Pure.
 */
export function splitStarted<T extends { key: string }>(requests: readonly T[], started: ReadonlySet<string>): { started: T[]; rest: T[] } {
  return { started: requests.filter((r) => started.has(r.key)), rest: requests.filter((r) => !started.has(r.key)) };
}
