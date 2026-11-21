// What a session's linked pull or merge requests say about it: the last-seen state of its newest
// one (model.ts `RequestLink.state`). Status (status.ts) reads it to tell "Ready to review" from
// "Done". Pure, shared with the UI.
import type { PullRequestState } from './details.ts';
import type { RequestLink, SessionRequestLink } from '../model.ts';

const STATES: readonly string[] = ['open', 'draft', 'merged', 'closed'] satisfies PullRequestState[];

export const isPullRequestState = (v: unknown): v is PullRequestState => typeof v === 'string' && STATES.includes(v);

/**
 * The newest request's last-seen state, or null when there is no link or its state is unknown.
 * Newest is the highest number among the links for the host the session's repository answers to
 * now, taken to be the host of the link made most recently (a repository moved to another kind of
 * host links its later requests there; the older host's numbers are not comparable).
 */
export function newestRequestState(links: readonly RequestLink[]): PullRequestState | null {
  const latest = links.reduce<RequestLink | null>((best, link) => (best === null || link.linkedAt >= best.linkedAt ? link : best), null);
  if (!latest) return null;
  const newest = links.filter((link) => link.host === latest.host).reduce((a, b) => (b.number > a.number ? b : a));
  return newest.state ?? null;
}

/** Each session's `newestRequestState`, by session id; a session with no links is not in it. */
export function requestStatesBySession(rows: readonly SessionRequestLink[]): Map<string, PullRequestState | null> {
  const bySession = new Map<string, SessionRequestLink[]>();
  for (const row of rows) {
    const list = bySession.get(row.sessionId);
    if (list) list.push(row);
    else bySession.set(row.sessionId, [row]);
  }
  return new Map([...bySession].map(([id, links]) => [id, newestRequestState(links)]));
}
