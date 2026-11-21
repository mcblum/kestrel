// The workspace's Pull requests page as data: every request linked to a session that is in sight, or
// to one archived within the last week,
// one entry per request (the same request linked to two sessions is one entry naming both), grouped
// by project, with the page's filter chips and their counts. Pure and shared with the UI; the route
// that builds it is pull-request-list-api.ts, the page ui/src/pages/PullRequestsPage.tsx.
import type { RequestLink } from '../model.ts';
import { isPullRequest, type PullRequest } from './details.ts';
import { isHostKind, type HostKind } from './host-terms.ts';
import { activityAt } from './session-order.ts';

/** A session a request is linked to, as the page names it. */
export interface LinkedSession {
  id: string;
  title: string;
  /** The session is archived: it is named, and found in Settings → Archived, not opened from here. */
  archived?: boolean;
}

/**
 * How long a request stays on the page after its session is archived: a week from the session's
 * last activity (Matt, 2026-11-19). Archiving a finished session must not empty the page of what
 * was merged yesterday.
 */
export const ARCHIVED_REQUEST_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** The archived sessions whose requests are still listed at `now`. Pure. */
export function keptAfterArchive<S extends { updatedAt: number; lastActivityAt?: number }>(archived: readonly S[], now: number): S[] {
  return archived.filter((s) => now - activityAt(s) <= ARCHIVED_REQUEST_KEEP_MS);
}

/** One request on the page. */
export interface ListedRequest {
  /** The project whose repository the request is in; null for a session with none. */
  projectId: string | null;
  host: HostKind;
  pullRequest: PullRequest;
  /** Every session linked to it, in the order they were found. Never empty. */
  sessions: LinkedSession[];
  /** Only the stored link is known (its host could not be asked): no title, nothing about checks. */
  minimal: boolean;
}

/** A project whose host could not be asked, and why. */
export interface UnaskedProject {
  projectId: string | null;
  reason: string;
}

/** The route's answer. */
export interface PullRequestList {
  requests: ListedRequest[];
  unasked: UnaskedProject[];
}

/** One session's requests, as the route gathered them: from its lookup, or its stored links. */
export interface SessionRequests {
  projectId: string | null;
  session: LinkedSession;
  host: HostKind;
  pullRequests: readonly PullRequest[];
  minimal: boolean;
}

/**
 * What the page knows of a request whose host could not be asked: its number, its link and the
 * state it was last seen in (open when never recorded). No title; checks and review unknown.
 */
export function minimalRequest(link: Pick<RequestLink, 'number' | 'url' | 'state'>): PullRequest {
  return { number: link.number, title: '', state: link.state ?? 'open', checks: 'none', review: 'none', url: link.url };
}

/** The stored links of a session whose lookup is unavailable, grouped by host. Pure. */
export function minimalRequests(projectId: string | null, session: LinkedSession, links: readonly RequestLink[]): SessionRequests[] {
  const hosts = [...new Set(links.map((link) => link.host))];
  return hosts.map((host) => ({ projectId, session, host, minimal: true, pullRequests: links.filter((link) => link.host === host).map(minimalRequest) }));
}

/** What makes two entries the same request. */
export const requestKey = (projectId: string | null, host: HostKind, number: number): string => `${projectId ?? ''}\n${host}\n${number}`;

const withSession = (sessions: readonly LinkedSession[], session: LinkedSession): LinkedSession[] => (sessions.some((s) => s.id === session.id) ? [...sessions] : [...sessions, session]);

/**
 * Every session's requests as one list, one entry per project + host + number, naming every session
 * linked to it. A looked-up copy wins over a minimal one; between looked-up copies the first wins.
 * Newest number first within a project. Pure: returns new entries.
 */
export function mergeSessionRequests(gathered: readonly SessionRequests[]): ListedRequest[] {
  const byKey = new Map<string, ListedRequest>();
  for (const entry of gathered) {
    for (const pr of entry.pullRequests) {
      const key = requestKey(entry.projectId, entry.host, pr.number);
      const before = byKey.get(key);
      const sessions = withSession(before?.sessions ?? [], entry.session);
      const keepBefore = before && (!before.minimal || entry.minimal);
      byKey.set(key, keepBefore ? { ...before, sessions } : { projectId: entry.projectId, host: entry.host, pullRequest: pr, sessions, minimal: entry.minimal });
    }
  }
  return [...byKey.values()].sort((a, b) => b.pullRequest.number - a.pullRequest.number);
}

/**
 * Each entry's sessions in the order they were linked to it (`linkedAt` of each session's link),
 * so "its first session" is the one that had it first; a session with no stored link for it, or a
 * tie, keeps its place. Pure: returns new entries.
 */
export function sessionsByLinkTime(requests: readonly ListedRequest[], links: readonly (Pick<RequestLink, 'host' | 'number' | 'linkedAt'> & { sessionId: string })[]): ListedRequest[] {
  const at = (r: ListedRequest, sessionId: string) => links.find((l) => l.sessionId === sessionId && l.host === r.host && l.number === r.pullRequest.number)?.linkedAt ?? Infinity;
  return requests.map((r) => {
    const ranked = r.sessions.map((s, index) => ({ s, index, at: at(r, s.id) }));
    const sessions = ranked.sort((a, b) => (a.at === b.at ? a.index - b.index : a.at < b.at ? -1 : 1)).map(({ s }) => s);
    return { ...r, sessions };
  });
}

/** One reason per project, the first one given. Pure. */
export function unaskedProjects(failures: readonly UnaskedProject[]): UnaskedProject[] {
  return failures.filter((f, i) => failures.findIndex((other) => other.projectId === f.projectId) === i);
}

// ---- filters ------------------------------------------------------------------------------------

export const REQUEST_FILTERS = ['open', 'attention', 'ready', 'draft', 'finished'] as const;
export type RequestFilter = (typeof REQUEST_FILTERS)[number];
export const DEFAULT_REQUEST_FILTER: RequestFilter = 'open';

export const REQUEST_FILTER_LABEL: Readonly<Record<RequestFilter, string>> = {
  open: 'Open',
  attention: 'Needs attention',
  ready: 'Ready to merge',
  draft: 'Draft',
  finished: 'Merged/closed',
};

/** What the page says when a filter has nothing in it. */
export const REQUEST_FILTER_EMPTY: Readonly<Record<RequestFilter, string>> = {
  open: 'No open PRs',
  attention: 'No PRs need attention',
  ready: 'No PRs are ready to merge',
  draft: 'No draft PRs',
  finished: 'No merged or closed PRs',
};

export const isRequestFilter = (value: unknown): value is RequestFilter => typeof value === 'string' && (REQUEST_FILTERS as readonly string[]).includes(value);

/** Open (not a draft) and something stands in its way: checks, review, conflicts, branch behind, merge rules. */
export function needsAttention(pr: PullRequest): boolean {
  if (pr.state !== 'open') return false;
  return pr.checks === 'failing' || pr.review === 'changes-requested' || pr.readiness === 'conflicts' || pr.readiness === 'behind' || pr.readiness === 'blocked';
}

const MATCHES: Readonly<Record<RequestFilter, (pr: PullRequest) => boolean>> = {
  open: (pr) => pr.state === 'open' || pr.state === 'draft',
  attention: needsAttention,
  ready: (pr) => pr.state === 'open' && pr.readiness === 'ready',
  draft: (pr) => pr.state === 'draft',
  finished: (pr) => pr.state === 'merged' || pr.state === 'closed',
};

export const matchesRequestFilter = (pr: PullRequest, filter: RequestFilter): boolean => MATCHES[filter](pr);

export type RequestCounts = Record<RequestFilter, number>;

/** How many requests each chip would show. Pure. */
export function countRequests(requests: readonly Pick<ListedRequest, 'pullRequest'>[]): RequestCounts {
  const counts = Object.fromEntries(REQUEST_FILTERS.map((f) => [f, 0])) as RequestCounts;
  for (const { pullRequest } of requests) for (const f of REQUEST_FILTERS) if (MATCHES[f](pullRequest)) counts[f] += 1;
  return counts;
}

/** The chips, in the page's order, each with its count. */
export const requestFilterChips = (counts: RequestCounts): { key: RequestFilter; label: string; count: number }[] => REQUEST_FILTERS.map((key) => ({ key, label: REQUEST_FILTER_LABEL[key], count: counts[key] }));

// ---- grouping -----------------------------------------------------------------------------------

export interface ProjectRequests {
  projectId: string | null;
  requests: ListedRequest[];
}

/**
 * The requests that match `filter`, one group per project in `projectOrder` (the sidebar's), then
 * any project not in it, then those with no project. Empty groups are left out. Pure.
 */
export function groupByProject(requests: readonly ListedRequest[], filter: RequestFilter, projectOrder: readonly string[]): ProjectRequests[] {
  const shown = requests.filter((r) => MATCHES[filter](r.pullRequest));
  const others = [...new Set(shown.map((r) => r.projectId))].filter((id): id is string => id !== null && !projectOrder.includes(id));
  const order: (string | null)[] = [...projectOrder, ...others, null];
  return order.map((projectId) => ({ projectId, requests: shown.filter((r) => r.projectId === projectId) })).filter((g) => g.requests.length > 0);
}

// ---- checking the answer ------------------------------------------------------------------------

const isLinkedSession = (v: unknown): v is LinkedSession => {
  const s = v as LinkedSession | null;
  return typeof s === 'object' && s !== null && typeof s.id === 'string' && typeof s.title === 'string';
};

const isProjectId = (v: unknown): v is string | null => v === null || typeof v === 'string';

const isListedRequest = (v: unknown): v is ListedRequest => {
  const r = v as ListedRequest | null;
  return typeof r === 'object' && r !== null && isProjectId(r.projectId) && isHostKind(r.host) && isPullRequest(r.pullRequest) && Array.isArray(r.sessions) && r.sessions.length > 0 && r.sessions.every(isLinkedSession) && typeof r.minimal === 'boolean';
};

const isUnasked = (v: unknown): v is UnaskedProject => {
  const u = v as UnaskedProject | null;
  return typeof u === 'object' && u !== null && isProjectId(u.projectId) && typeof u.reason === 'string';
};

export const isWorkspaceRequests = (v: unknown): v is PullRequestList => {
  const l = v as PullRequestList | null;
  return typeof l === 'object' && l !== null && Array.isArray(l.requests) && l.requests.every(isListedRequest) && Array.isArray(l.unasked) && l.unasked.every(isUnasked);
};
