// The cards about a session's pull request (Matt, 2026-11-27, issue 78): the "needs you" card
// (suggestions/request-kind.ts), the Autopilot offer (suggestions/autopilot-kind.ts) and the offer to review
// the work (suggestions/review-kind.ts). One rule says where such a card is shown and when it goes by
// itself; the server's suggestions follow it, and the window hides a card the moment its request's state
// says so, before the server's withdrawal arrives. Pure and browser-safe.
//
// - Where: a session another session started as a child (a delegate, `isChildLink`) has its card shown on
//   the session the user is looking at: the top of its delegate tree (`rootOf`), or the lead of the
//   workstream that top is in. The card names the session it is about and acts on that session (its
//   `about`), exactly as it would on the child; it is shown once, there, and nowhere else. Any other
//   session (no parent, or started by a handoff, which is clean) keeps its own cards.
// - When it goes: the request the card is about was merged or closed. It is withdrawn (expired, with a
//   line saying why), never answered: nothing is pressed, nothing is posted.
import type { Link, Workstream } from '../model.ts';
import { childLinkOf, rootOf } from '../tree.ts';
import type { PullRequestLookup } from './details.ts';
import { hostTerms, isHostKind, requestNumber } from './host-terms.ts';
import type { Sourced } from './sourced.ts';
import type { Suggestion } from './suggestions.ts';
import { leadOf, workstreamOf } from './workstreams.ts';

/** The kinds of card that are about a session's pull request (each kind's own `*_KIND` constant). */
export const REQUEST_CARD_KINDS: readonly string[] = ['pull-request', 'autopilot', 'review'];

export const isRequestCard = (kind: string): boolean => REQUEST_CARD_KINDS.includes(kind);

/** The session a card is about and acts on: its `about`, else the session whose conversation it is in. */
export const cardSession = (s: Pick<Suggestion, 'sessionId' | 'about'>): string => s.about ?? s.sessionId;

/**
 * Where a card about `sessionId`'s pull request is shown. A delegate child's goes to the top of its tree,
 * or that top's workstream lead; `present` says whether a session is in sight (not archived, not gone):
 * a home that is not falls back to the next one down, and at last to the session itself.
 */
export function requestCardHome(sessionId: string, links: readonly Link[], workstreams: readonly Pick<Workstream, 'sessionIds'>[], present: (id: string) => boolean): string {
  if (!childLinkOf(sessionId, links)) return sessionId;
  const root = rootOf(sessionId, links);
  const stream = workstreamOf(workstreams, root);
  const lead = stream ? leadOf(stream) : null;
  for (const home of [lead, root]) if (home && home !== sessionId && present(home)) return home;
  return sessionId;
}

/** The request a card names: its host and number; null when it names none (a review asked for before any request). */
function requestOf(card: Pick<Suggestion, 'payload'>, lookup: Extract<Sourced<PullRequestLookup>, { state: 'ready' }>): { where: string; number: number } | null {
  const { number, host } = card.payload;
  if (typeof number !== 'number') return null;
  return { number, where: requestNumber(hostTerms(isHostKind(host) ? host : lookup.value.host), number) };
}

/**
 * Why a card about a request no longer applies by itself: that request was merged or closed. `lookup` is
 * the PR store's answer for the session the card is about (`cardSession`). Null while it still applies, for
 * a card of another kind, a card that names no request, or when the store has no answer.
 */
export function requestCardGone(card: Pick<Suggestion, 'kind' | 'payload' | 'state'>, lookup: Sourced<PullRequestLookup> | null | undefined): string | null {
  if (card.state !== 'open' || !isRequestCard(card.kind) || !lookup || lookup.state !== 'ready') return null;
  const request = requestOf(card, lookup);
  const pr = request && lookup.value.pullRequests.find((p) => p.number === request.number);
  if (!request || !pr) return null;
  if (pr.state === 'merged') return `${request.where} was merged`;
  if (pr.state === 'closed') return `${request.where} was closed`;
  return null;
}
