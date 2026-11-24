// What a phone reads of the Code reviews and Tickets pages (kestrel-connect.md, "The Code reviews and
// Tickets pages on a phone"): the views the window's pushes carry, or off in the desk's words. One
// definition for the dispatcher's reads, its pushes and the held records. Pure.
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
