// How often the server asks a host again about a session's pull requests (pull-requests/store.ts),
// by what it last heard: soon while something is about to change (checks running, readiness not
// known yet), less often for a request that is just open, slowly while none is linked (one may be
// opened), and never once every request is merged or closed. The UI never asks on a timer: it holds
// what the server pushed. Pure.
import { primaryPullRequest, type PullRequestLookup } from './details.ts';
import type { Sourced } from './sourced.ts';

export const CHANGING_POLL_MS = 15_000;
export const OPEN_POLL_MS = 60_000;
/** None linked yet, or the host could not be asked: one may be opened, or the host may come back. */
export const IDLE_POLL_MS = 180_000;

/**
 * A session a window has open is asked about this often whatever it last answered (Matt,
 * 2026-11-18): the user is looking at its header, and a status that changed after a push (conflicts
 * gone, checks started) must not sit there for a minute. Merged and closed still end the watching.
 */
export const WATCHED_POLL_MS = 10_000;

/** When to ask again, given when it was last asked and whether a window has the session open. Null: never. Pure. */
export function nextPullRequestAsk(value: Sourced<PullRequestLookup>, askedAt: number, watched: boolean): number | null {
  const poll = pullRequestPollMs(value);
  if (poll === null) return null;
  return askedAt + (watched ? Math.min(poll, WATCHED_POLL_MS) : poll);
}

/** Milliseconds until the next ask, or null when there is nothing left to watch. */
export function pullRequestPollMs(value: Sourced<PullRequestLookup>): number | null {
  if (value.state !== 'ready') return IDLE_POLL_MS;
  const pr = primaryPullRequest(value.value.pullRequests);
  if (!pr) return IDLE_POLL_MS;
  if (pr.state === 'merged' || pr.state === 'closed') return null;
  const changing = pr.checks === 'running' || pr.readiness === undefined || pr.readiness === 'unknown';
  return changing ? CHANGING_POLL_MS : OPEN_POLL_MS;
}
