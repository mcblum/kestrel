// The workspace's Pull requests page (ui/src/pages/PullRequestsPage.tsx):
//
//   GET /api/pull-requests[?refresh=1]   { requests: ListedRequest[], unasked: UnaskedProject[] }
//
// Every request linked to a session that is in sight, or to an archived one for a week after its
// last activity (`keptAfterArchive`; the session is then marked archived), one entry per project + host +
// number naming every session linked to it, the one that had it first first (shared/pull-request-list.ts). Built from each linked
// session's own lookup (details-api.ts `sessionLookup`) through the same 10-second cache, so a
// session the sidebar or a table just asked about costs nothing more; at most LOOKUP_CONCURRENCY
// lookups run at once. A session whose lookup is unavailable contributes its stored links as
// minimal entries, and its project is listed in `unasked` with the reason, so one host that cannot
// be asked never empties the page. `refresh=1` skips the cache. Shaped like details-api.ts.
import type { RequestLink, SessionRequestLink, SessionView } from './model.ts';
import { sessionLookup, type DetailsAnswer, type DetailsSources } from './details-api.ts';
import { keptAfterArchive, mergeSessionRequests, minimalRequests, sessionsByLinkTime, unaskedProjects, type PullRequestList, type SessionRequests, type UnaskedProject } from './shared/pull-request-list.ts';
import type { PullRequestLookup } from './shared/details.ts';
import { reasonOf, unavailable, type Sourced } from './shared/sourced.ts';
import type { Workspace } from './workspace.ts';

/** How many sessions are looked up at once: each may run gh or glab, so not all of them together. */
export const LOOKUP_CONCURRENCY = 4;

/** `run` over every item, at most `limit` at a time; answers in the items' order. */
export async function mapLimited<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const answers: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      answers[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return answers;
}

interface Gathered {
  requests: SessionRequests[];
  failure: UnaskedProject | null;
}

/** One session's part of the page: its lookup, or its stored links when the lookup is unavailable. */
async function gather(session: SessionView, links: readonly RequestLink[], archived: boolean, ask: (session: SessionView) => Promise<Sourced<PullRequestLookup>>): Promise<Gathered> {
  const named = { id: session.id, title: session.title, ...(archived ? { archived: true } : {}) };
  const projectId = session.startedIn;
  const answer = await ask(session).catch((error: unknown) => unavailable(reasonOf(error)));
  if (answer.state === 'ready') return { requests: [{ projectId, session: named, host: answer.value.host, pullRequests: answer.value.pullRequests, minimal: false }], failure: null };
  const reason = answer.state === 'unavailable' ? answer.reason : 'Still loading';
  return { requests: minimalRequests(projectId, named, links), failure: { projectId, reason } };
}

/** The sessions among these that have at least one linked request, with their links. */
function linkedSessions(sessions: readonly SessionView[], rows: readonly SessionRequestLink[], archived: boolean): { session: SessionView; links: RequestLink[]; archived: boolean }[] {
  return sessions.flatMap((session) => {
    const links = rows.filter((row) => row.sessionId === session.id).map(({ sessionId: _session, ...link }) => link);
    return links.length > 0 ? [{ session, links, archived }] : [];
  });
}

/** The page's answer. */
export async function workspaceRequests(workspace: Workspace, sources: DetailsSources, refresh: boolean, sample: boolean, now: number = Date.now()): Promise<PullRequestList> {
  const state = await workspace.state();
  const rows = await workspace.allRequestLinks();
  // In sight first, so a request both kinds of session link is looked up through one in sight.
  const linked = [...linkedSessions(state.sessions, rows, false), ...linkedSessions(keptAfterArchive(state.archived.sessions, now), rows, true)];
  const ask = (session: SessionView) => sessionLookup(state, session, workspace, sources, refresh, sample);
  const parts = await mapLimited(linked, LOOKUP_CONCURRENCY, ({ session, links, archived }) => gather(session, links, archived, ask));
  // Read again: a lookup links the requests it found on a session's branch, stamped with when.
  const linkedNow = await workspace.allRequestLinks();
  return {
    requests: sessionsByLinkTime(mergeSessionRequests(parts.flatMap((p) => p.requests)), linkedNow),
    unasked: unaskedProjects(parts.flatMap((p) => (p.failure ? [p.failure] : []))),
  };
}

/** Answers the Pull requests route, or null when the path is not it. */
export async function pullRequestListRoute(parts: readonly string[], method: string, url: URL, workspace: Workspace, sources: DetailsSources, sample: boolean): Promise<DetailsAnswer | null> {
  if (method !== 'GET' || parts.length !== 2 || parts[1] !== 'pull-requests') return null;
  const refresh = url.searchParams.get('refresh');
  if (refresh !== null && refresh !== '1') return { status: 400, body: { error: 'refresh must be 1 or absent.' } };
  return { status: 200, body: await workspaceRequests(workspace, sources, refresh === '1', sample) };
}
