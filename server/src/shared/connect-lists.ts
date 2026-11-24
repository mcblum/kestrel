// What a phone reads of the Code reviews and Tickets pages (kestrel-connect.md, "The Code reviews and
// Tickets pages on a phone"): the views the window's pushes carry, or off in the desk's words. One
// definition for the dispatcher's reads, its pushes and the held records. Pure.
import type { SessionView } from '../model.ts';
import type { PullRequestLookup } from './details.ts';
import { attentionBySession, type AttentionPrefs, type AttentionSession, type RequestAttention } from './request-attention.ts';
import type { Sourced } from './sourced.ts';
import { REVIEWS_OFF_REASON, type ReviewMode } from './review-settings.ts';
import type { ReviewRequestsView } from './review-requests.ts';
import { ticketsOn, ticketSourcesOff, TICKETS_OFF_REASON, type TicketsView } from './tickets.ts';

export type ReviewsAnswer = { on: false; reason: string } | { on: true; view: ReviewRequestsView };
export type TicketsAnswer = { on: false; reason: string } | { on: true; view: TicketsView; sourcesOff: string[] };

export function reviewsAnswer(view: ReviewRequestsView, mode: ReviewMode): ReviewsAnswer {
  return mode === 'off' ? { on: false, reason: REVIEWS_OFF_REASON } : { on: true, view };
}

export function ticketsAnswer(view: TicketsView): TicketsAnswer {
  return ticketsOn(view) ? { on: true, view, sourcesOff: ticketSourcesOff(view.settings) } : { on: false, reason: TICKETS_OFF_REASON };
}

/**
 * The answers as held while the desk is away: no ticket `details` (a cache of the pages the desk opened),
 * and nothing of a project kept off Kestrel Connect (`keptOff` holds its project ids; `none` is not a
 * project a request or a link names).
 */
export function heldLists(reviews: ReviewsAnswer, tickets: TicketsAnswer, keptOff: readonly string[], sessionProject: (sessionId: string) => string | null): { reviews: ReviewsAnswer; tickets: TicketsAnswer } {
  const off = new Set(keptOff);
  const kept = (projectId: string | null) => projectId === null || !off.has(projectId);
  const heldReviews: ReviewsAnswer = reviews.on
    ? { on: true, view: { ...reviews.view, requests: reviews.view.requests.filter((r) => kept(r.projectId)), dismissed: reviews.view.dismissed.filter((r) => kept(r.projectId)) } }
    : reviews;
  const heldTickets: TicketsAnswer = tickets.on
    ? { ...tickets, view: { ...tickets.view, details: {}, links: tickets.view.links.filter((l) => l.attachedTo !== 'session' || kept(sessionProject(l.id))) } }
    : tickets;
  return { reviews: heldReviews, tickets: heldTickets };
}

/** A session's pull request as a phone reads it (2026-11-24): the PR store's answers as the window's push has them, the desk's one fact of what needs the user, and the Settings → Git choices that fact was worked out with. */
export interface PullRequestsAnswer {
  pullRequests: Record<string, Sourced<PullRequestLookup>>;
  attention: Record<string, RequestAttention>;
  prefs: AttentionPrefs;
}

type PullRequestSession = AttentionSession & Partial<Pick<SessionView, 'aside'>>;

/**
 * The answer from what the store holds: no sidebar (it has no request of its own and is listed nowhere), and
 * `attention` by the one rule (`attentionBySession`), so a phone never works the fact out itself. `sessions` are
 * the workspace's; a lookup for a session not among them (deleted, archived) is left out too.
 */
export function pullRequestsAnswer(sessions: readonly PullRequestSession[], all: Readonly<Record<string, Sourced<PullRequestLookup> | undefined>>, prefs: AttentionPrefs): PullRequestsAnswer {
  const shown = sessions.filter((s) => !s.aside);
  const pullRequests: Record<string, Sourced<PullRequestLookup>> = {};
  for (const s of shown) {
    const lookup = all[s.id];
    if (lookup) pullRequests[s.id] = lookup;
  }
  const attention = Object.fromEntries(attentionBySession(shown, (id) => all[id], prefs));
  return { pullRequests, attention, prefs };
}

/** The pull-request answer as held while the desk is away: only the sessions the held index holds. */
export function heldPullRequests(answer: PullRequestsAnswer, held: ReadonlySet<string>): PullRequestsAnswer {
  const keep = <T>(record: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(record).filter(([id]) => held.has(id)));
  return { ...answer, pullRequests: keep(answer.pullRequests), attention: keep(answer.attention) };
}
