// The lists a phone of the account reads as the window has them (kestrel-connect.md, "The Code reviews and
// Tickets pages on a phone", and "What a phone gets of the desk's changes of 2026-11-24"): the views the
// stores already built for the window's pushes, or off in the desk's words, and each session's pull request
// with what needs the user. One source for the dispatcher's reads and pushes and for the held records, so
// nothing is worked out per request. Opens no socket and asks no host or tracker.
import type { PullRequestStore } from '../pull-requests/store.ts';
import type { ReviewRequestStore } from '../review-requests/store.ts';
import type { ReviewPrefs } from '../review-settings/prefs.ts';
import { pullRequestsAnswer, reviewsAnswer, ticketsAnswer, type PullRequestsAnswer, type ReviewsAnswer, type TicketsAnswer } from '../shared/connect-lists.ts';
import { DEFAULT_ATTENTION_PREFS, type AttentionPrefs } from '../shared/request-attention.ts';
import { NO_REVIEW_REQUESTS } from '../shared/review-requests.ts';
import type { ReviewMode } from '../shared/review-settings.ts';
import { NO_TICKETS } from '../shared/tickets.ts';
import type { TicketStore } from '../tickets/store.ts';
import type { Workspace } from '../workspace.ts';

export type ListKind = 'reviews' | 'tickets' | 'pull-requests';

export interface ConnectLists {
  reviews(): Promise<ReviewsAnswer>;
  tickets(): TicketsAnswer;
  pullRequests(): Promise<PullRequestsAnswer>;
  /** Called with the list that changed: a store's view, the review mode, or (only when its answer really differs) the pull requests. */
  onChange(listener: (kind: ListKind) => void): () => void;
}

/** What the pull-request answer is made from: the PR store, Settings → Git's choices, and the sessions (idle or not). */
export interface PullRequestSources {
  store: Pick<PullRequestStore, 'all' | 'onChange'>;
  prefs: { attention(): Promise<AttentionPrefs>; onAttentionChange(listener: () => void): () => void };
  workspace: Pick<Workspace, 'state' | 'onChange'>;
}

/** A burst of changes to what the pull-request answer is made from is one look, this long after the first. */
export const PULL_REQUESTS_LOOK_MS = 100;

export function connectLists(prefs: Pick<ReviewPrefs, 'current' | 'onChange'>, reviewRequests: Pick<ReviewRequestStore, 'view' | 'onChange'> | null, tickets: Pick<TicketStore, 'view' | 'onChange'> | null, pulls: PullRequestSources | null = null): ConnectLists {
  // The mode is read once and then kept from the setting's own change events: no read per request.
  let mode: Promise<ReviewMode> | null = null;
  const modeNow = () => (mode ??= prefs.current().then((s) => s.mode));
  prefs.onChange((s) => {
    mode = Promise.resolve(s.mode);
  });
  const pullRequests = async (): Promise<PullRequestsAnswer> => {
    if (!pulls) return pullRequestsAnswer([], {}, DEFAULT_ATTENTION_PREFS);
    const [state, attention] = await Promise.all([pulls.workspace.state(), pulls.prefs.attention()]);
    return pullRequestsAnswer(state.sessions, pulls.store.all(), attention, { links: state.links, workstreams: state.workstreams });
  };
  return {
    reviews: async () => reviewsAnswer(reviewRequests?.view() ?? NO_REVIEW_REQUESTS, await modeNow()),
    tickets: () => ticketsAnswer(tickets?.view() ?? NO_TICKETS),
    pullRequests,
    onChange(listener) {
      const offs = [prefs.onChange(() => listener('reviews')), reviewRequests?.onChange(() => listener('reviews')), tickets?.onChange(() => listener('tickets')), ...(pulls ? [watchPullRequests(pulls, pullRequests, () => listener('pull-requests'))] : [])];
      return () => {
        for (const off of offs) off?.();
      };
    },
  };
}

/**
 * Tells `changed` when the pull-request answer really differs from the last one: the workspace changes often
 * (every write), and whether a session is idle is one of the inputs, so each burst is looked at once and
 * compared, never pushed as it comes.
 */
function watchPullRequests(pulls: PullRequestSources, answer: () => Promise<PullRequestsAnswer>, changed: () => void): () => void {
  let last: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  const look = async () => {
    timer = null;
    try {
      const now = JSON.stringify(await answer());
      if (closed || now === last) return;
      const first = last === null;
      last = now;
      if (!first) changed();
    } catch (error) {
      console.error('[kestrel] could not read the pull requests for Kestrel Connect', error);
    }
  };
  const poke = () => {
    if (!closed) timer ??= setTimeout(() => void look(), PULL_REQUESTS_LOOK_MS);
  };
  void look();
  const offs = [pulls.store.onChange(() => poke()), pulls.prefs.onAttentionChange(poke), pulls.workspace.onChange(poke)];
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    for (const off of offs) off();
  };
}
