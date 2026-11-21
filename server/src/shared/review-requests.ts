// Pull and merge requests somebody asked the user to review: what the server finds on each host
// (review-requests/) and pushes, and what the sidebar's CODE REVIEWS section lists. Only a request
// made of the user by name counts, never one made of a team they are in. Pure and browser-safe.
import { hostTerms, isHostKind, type HostKind } from './host-terms.ts';

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
  requests: ReviewRequest[];
  problems: ReviewRequestProblem[];
  /** The order the user dragged the CODE REVIEWS rows into, as request keys; used when sessions are in a custom order. */
  order: string[];
}

export const NO_REVIEW_REQUESTS: ReviewRequestsView = { requests: [], problems: [], order: [] };

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

/** What a request row's status mark says. A row with a review session shows that session's own dot instead. */
export interface RequestStatus {
  /** `idle`: nothing has happened yet. `needs-you`: Kestrel tried to start it and could not. */
  tone: 'idle' | 'needs-you';
  label: string;
}

export const requestStatus = (request: Pick<ReviewRequest, 'notStarted'>): RequestStatus =>
  request.notStarted ? { tone: 'needs-you', label: `Could not start on its own: ${request.notStarted}` } : { tone: 'idle', label: 'No review started' };

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
  const v = raw as { requests?: unknown; problems?: unknown };
  if (!Array.isArray(v.requests) || !Array.isArray(v.problems)) return NO_REVIEW_REQUESTS;
  const order = Array.isArray((raw as { order?: unknown }).order) ? ((raw as { order: unknown[] }).order.filter(isString) as string[]) : [];
  return { requests: v.requests.filter(isReviewRequest), problems: v.problems.filter(isProblem), order };
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
