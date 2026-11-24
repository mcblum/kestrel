// The Code reviews and Tickets lists as a phone of the account reads them (kestrel-connect.md, "The Code
// reviews and Tickets pages on a phone"): the views the stores already built for the window's pushes, or
// off in the desk's words. One source for the dispatcher's reads and pushes and for the held records, so
// nothing is worked out per request. Opens no socket and asks no host or tracker.
import type { ReviewRequestStore } from '../review-requests/store.ts';
import type { ReviewPrefs } from '../review-settings/prefs.ts';
import { reviewsAnswer, ticketsAnswer, type ReviewsAnswer, type TicketsAnswer } from '../shared/connect-lists.ts';
import { NO_REVIEW_REQUESTS } from '../shared/review-requests.ts';
import type { ReviewMode } from '../shared/review-settings.ts';
import { NO_TICKETS } from '../shared/tickets.ts';
import type { TicketStore } from '../tickets/store.ts';

export type ListKind = 'reviews' | 'tickets';

export interface ConnectLists {
  reviews(): Promise<ReviewsAnswer>;
  tickets(): TicketsAnswer;
  /** Called with the list that changed: a store's view, or the review mode. */
  onChange(listener: (kind: ListKind) => void): () => void;
}

export function connectLists(prefs: Pick<ReviewPrefs, 'current' | 'onChange'>, reviewRequests: Pick<ReviewRequestStore, 'view' | 'onChange'> | null, tickets: Pick<TicketStore, 'view' | 'onChange'> | null): ConnectLists {
  // The mode is read once and then kept from the setting's own change events: no read per request.
  let mode: Promise<ReviewMode> | null = null;
  const modeNow = () => (mode ??= prefs.current().then((s) => s.mode));
  prefs.onChange((s) => {
    mode = Promise.resolve(s.mode);
  });
  return {
    reviews: async () => reviewsAnswer(reviewRequests?.view() ?? NO_REVIEW_REQUESTS, await modeNow()),
    tickets: () => ticketsAnswer(tickets?.view() ?? NO_TICKETS),
    onChange(listener) {
      const offs = [prefs.onChange(() => listener('reviews')), reviewRequests?.onChange(() => listener('reviews')), tickets?.onChange(() => listener('tickets'))];
      return () => {
        for (const off of offs) off?.();
      };
    },
  };
}
