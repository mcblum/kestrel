// Pull and merge requests somebody asked the user to review: what the server finds on each host
// (review-requests/) and pushes, and what the sidebar's CODE REVIEWS section lists. Only a request
// made of the user by name counts, never one made of a team they are in. Pure and browser-safe.
import { hostTerms, isHostKind, type HostKind } from './host-terms.ts';
import { sessionDot, type Seen } from './unread.ts';
import { agoText } from './when.ts';

/** A request as a host reports it, before Kestrel knows which project it belongs to. */
export interface FoundReviewRequest {
  host: HostKind;
  /** The server's name: "github.com", or a GitLab server's. */
  hostName: string;
  /** "owner/name" on GitHub, the full path ("group/sub/name") on GitLab. */
  repository: string;
  number: number;
  title: string;
  /** The author's login; empty when the host did not say. */
  author: string;
  url: string;
  /** When it last changed, in milliseconds; 0 when the host did not say. */
  updatedAt: number;
  /** When the request was opened, in milliseconds; absent when the host did not say. */
  openedAt?: number;
  /** Its description, when it has one. */
  body?: string;
  /** Who asked the user to review it, when the host says (review-requests/requester.ts). */
  requestedBy?: string;
}

export interface ReviewRequest extends FoundReviewRequest {
  /** What names it everywhere: in the store, in a page's path, as a row's key. */
  key: string;
  /** The registered project whose remote is this repository, or null when there is none. */
  projectId: string | null;
  /** Why Kestrel could not start a review of it on its own, when it tried and was refused. */
  notStarted?: string;
}

/** A host that could not be asked, with why. Its last answer, if it gave one, is still listed. */
export interface ReviewRequestProblem {
  hostName: string;
  reason: string;
}

/** Everything the server holds, as it is pushed. */
export interface ReviewRequestsView {
  /** The requests that wait on the user: every one a host lists, minus the ones the user dismissed. */
  requests: ReviewRequest[];
  /** The keys of the waiting requests the user has not looked at yet: new ones, until they are opened or marked read. */
  unread: string[];
  /** The requests a host still lists that the user dismissed, most recently changed first. Nothing is done with them until they are restored. */
  dismissed: ReviewRequest[];
  problems: ReviewRequestProblem[];
  /** The order the user dragged the CODE REVIEWS rows into, as request keys; used when sessions are in a custom order. */
  order: string[];
}

export const NO_REVIEW_REQUESTS: ReviewRequestsView = { requests: [], unread: [], dismissed: [], problems: [], order: [] };

/** How many dismissed keys, and how many read ones, are kept; past it the oldest are forgotten. */
export const MAX_DISMISSED = 5000;

/**
 * A kept list of keys (the dismissed ones, the read ones) after `keys` are added (`on`) or taken
 * out. A key keeps the place it was first added at; past MAX_DISMISSED the oldest go. Pure.
 */
export function withDismissed(held: readonly string[], keys: readonly string[], on: boolean): string[] {
  const changing = new Set(keys);
  const next = on ? [...new Set([...held, ...keys])] : held.filter((key) => !changing.has(key));
  return next.slice(Math.max(0, next.length - MAX_DISMISSED));
}

/** Stored dismissed keys, checked: whatever is not a list of keys reads as none dismissed. */
export function asDismissedKeys(raw: unknown): string[] {
  return Array.isArray(raw) ? withDismissed([], raw.filter((k): k is string => typeof k === 'string' && k.length > 0 && k.length <= 300), true) : [];
}

/**
 * The rows a capped list draws: every row `always` keeps (a review session, the row that is open),
 * and the first `limit` of the others. `hidden` is how many were left out. Pure.
 */
export function withinLimit<T>(rows: readonly T[], limit: number, always: (row: T) => boolean): { shown: T[]; hidden: number } {
  let taken = 0;
  const shown = rows.filter((row) => always(row) || taken++ < limit);
  return { shown, hidden: rows.length - shown.length };
}

/** One name for a request: the host, the repository and its number. */
export const reviewRequestKey = (r: Pick<FoundReviewRequest, 'hostName' | 'repository' | 'number'>): string => `${r.hostName}/${r.repository}/${r.number}`.toLowerCase();

/** How a repository is matched to a project's remote: host and path, whatever the case. */
export const repositoryKey = (hostName: string, repository: string): string => `${hostName}/${repository}`.toLowerCase();

/** "#12" on GitHub, "!12" on GitLab. */
export const requestNumberLabel = (r: Pick<FoundReviewRequest, 'host' | 'number'>): string => `${hostTerms(r.host).sigil}${r.number}`;

/** The repository's own name, without its owner or group. */
export const repositoryName = (repository: string): string => repository.slice(repository.lastIndexOf('/') + 1);

/** Most recently changed first; the key settles a tie so the order never flickers. */
export function orderReviewRequests<T extends Pick<ReviewRequest, 'updatedAt' | 'key'>>(requests: readonly T[]): T[] {
  return [...requests].sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
}

const isString = (v: unknown): v is string => typeof v === 'string';

/** Who the row names: whoever asked for the review, else (the host did not say) the request's author. */
export const askedBy = (request: Pick<FoundReviewRequest, 'requestedBy' | 'author'>): string => request.requestedBy || request.author;

/** A review row's second line: "Storefront #412 · priya". The project's name when it is one, else the repository's. */
export function reviewRowDetail(request: Pick<FoundReviewRequest, 'host' | 'number' | 'repository' | 'requestedBy' | 'author'>, projectName?: string | null): string {
  return [`${projectName || repositoryName(request.repository)} ${requestNumberLabel(request)}`, askedBy(request)].filter(Boolean).join(' · ');
}

/** How long ago the request was opened ("4 days ago"); empty when the host did not say. */
export const openedText = (request: Pick<FoundReviewRequest, 'openedAt'>, now: number): string => (request.openedAt ? agoText(request.openedAt, now) : '');

/** What a request row's status mark says. A row with a review session shows that session's own dot instead. */
export interface RequestStatus {
  /** `idle`: nothing has happened yet. `unread`: new, not looked at yet. `needs-you`: Kestrel tried to start it and could not. */
  tone: 'idle' | 'unread' | 'needs-you';
  label: string;
}

export function requestStatus(request: Pick<ReviewRequest, 'notStarted'>, unread = false): RequestStatus {
  if (request.notStarted) return { tone: 'needs-you', label: `Could not start on its own: ${request.notStarted}` };
  return unread ? { tone: 'unread', label: 'New: you have not opened it yet' } : { tone: 'idle', label: 'No review started' };
}

/**
 * The CODE REVIEWS rows in the order they are drawn. Sorted by most recent they are as pushed
 * (most recently changed first). In a custom order they follow `order`; a request not in it yet
 * is new, and goes first.
 */
export function inSidebarOrder<T extends Pick<ReviewRequest, 'key'>>(requests: readonly T[], order: readonly string[], custom: boolean): T[] {
  if (!custom || order.length === 0) return [...requests];
  const place = new Map(order.map((key, i) => [key, i]));
  const placed = requests.filter((r) => place.has(r.key)).sort((a, b) => place.get(a.key)! - place.get(b.key)!);
  return [...requests.filter((r) => !place.has(r.key)), ...placed];
}

/** `keys` with `moving` put before or after `target`. Pure. */
export function placeReview(keys: readonly string[], moving: string, target: string, after: boolean): string[] {
  const rest = keys.filter((key) => key !== moving);
  const at = rest.indexOf(target);
  if (at < 0) return [...rest, moving];
  return [...rest.slice(0, at + (after ? 1 : 0)), moving, ...rest.slice(at + (after ? 1 : 0))];
}

/** A stored or sent order, checked: a list of keys, each once; anything else is null. */
export function asReviewOrder(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > 1000 || !raw.every((k) => isString(k) && k.length > 0 && k.length <= 300)) return null;
  return [...new Set(raw as string[])];
}

function isReviewRequest(value: unknown): value is ReviewRequest {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    isHostKind(r.host) &&
    [r.key, r.hostName, r.repository, r.title, r.author, r.url].every(isString) &&
    typeof r.number === 'number' &&
    typeof r.updatedAt === 'number' &&
    (r.projectId === null || isString(r.projectId)) &&
    (r.openedAt === undefined || typeof r.openedAt === 'number') &&
    (r.body === undefined || isString(r.body)) &&
    (r.notStarted === undefined || isString(r.notStarted)) &&
    (r.requestedBy === undefined || isString(r.requestedBy))
  );
}

function isProblem(value: unknown): value is ReviewRequestProblem {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return isString(p.hostName) && isString(p.reason);
}

/** What a server pushed, checked: anything that is not a view (an older server) reads as nothing. */
export function asReviewRequestsView(raw: unknown): ReviewRequestsView {
  if (typeof raw !== 'object' || raw === null) return NO_REVIEW_REQUESTS;
  const v = raw as { requests?: unknown; problems?: unknown; dismissed?: unknown };
  if (!Array.isArray(v.requests) || !Array.isArray(v.problems)) return NO_REVIEW_REQUESTS;
  const dismissed = Array.isArray(v.dismissed) ? v.dismissed.filter(isReviewRequest) : [];
  const order = Array.isArray((raw as { order?: unknown }).order) ? ((raw as { order: unknown[] }).order.filter(isString) as string[]) : [];
  const unread = Array.isArray((raw as { unread?: unknown }).unread) ? ((raw as { unread: unknown[] }).unread.filter(isString) as string[]) : [];
  return { requests: v.requests.filter(isReviewRequest), unread, dismissed, problems: v.problems.filter(isProblem), order };
}

/**
 * What makes a session a review of somebody else's request: which request, and the commit of it
 * the session's worktree was made at. Only Kestrel sets it, when the review starts; it never changes.
 */
export interface ReviewMark {
  /** The request's key (`reviewRequestKey`). */
  key: string;
  host: HostKind;
  number: number;
  /** The commit at the request's head when the review started: what was reviewed. */
  sha: string;
  url: string;
}

/** A stored mark, checked: anything that is not one reads as no mark. */
export function asReviewMark(raw: unknown): ReviewMark | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (!isHostKind(m.host) || ![m.key, m.sha, m.url].every(isString) || typeof m.number !== 'number') return null;
  return { key: m.key as string, host: m.host, number: m.number, sha: m.sha as string, url: m.url as string };
}

/** "Review: <the request's title>": what a review session is called. */
export const reviewSessionTitle = (requestTitle: string): string => `Review: ${requestTitle}`;

/**
 * The sessions drawn under CODE REVIEWS: each one reviewing a request that still waits on the user.
 * Once the request is reviewed, merged, closed or taken back, its session is an ordinary one again
 * and goes back to its project. Pure.
 */
export function reviewingIds(sessions: readonly { id: string; review?: Pick<ReviewMark, 'key'> }[], requests: readonly Pick<ReviewRequest, 'key'>[]): Set<string> {
  const waiting = new Set(requests.map((r) => r.key));
  return new Set(sessions.filter((s) => s.review && waiting.has(s.review.key)).map((s) => s.id));
}

/** What `needsALook` reads of a session: the request it reviews, and what its row's dot goes by. */
export type ReviewingSession = Parameters<typeof sessionDot>[0] & { review?: Pick<ReviewMark, 'key'> };

/**
 * The waiting requests with something for the user to look at, by key, each once: the ones not
 * opened yet (`unread`), and the ones whose review session has new output or waits on an answer
 * (the session's own dot: unread.ts). So a review that finishes a turn shows up again, by the one
 * rule every session row's dot follows. Pure.
 */
export function needsALook(view: Pick<ReviewRequestsView, 'requests' | 'unread'>, sessions: readonly ReviewingSession[], seen: Seen | null): Set<string> {
  const waiting = new Set(view.requests.map((r) => r.key));
  const keys = new Set(view.unread.filter((key) => waiting.has(key)));
  for (const session of sessions) {
    if (!session.review || !waiting.has(session.review.key)) continue;
    const dot = sessionDot(session, seen);
    if (dot === 'unread' || dot === 'needs-you') keys.add(session.review.key);
  }
  return keys;
}
