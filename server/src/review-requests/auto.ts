// Starting reviews on their own (Settings → Git → Review requests, "Start reviews on their own").
// Which requests, and how many at once, is one pure rule (`reviewsToStart`); this runs it whenever
// the list, the setting or the sessions may have changed, and starts what it names. A start that
// is refused is not retried: its reason is put on the request (store.ts `note`) so its page says
// why, and is tried again only when the setting changes.
import type { ReviewRequest } from '../shared/review-requests.ts';
import { reviewsToStart, type ReviewSettings } from '../shared/review-settings.ts';
import type { ReviewRequestStore } from './store.ts';

export interface ReviewStarterDeps {
  settings(): Promise<ReviewSettings>;
  sessions(): Promise<readonly { state: string; review?: { key: string } }[]>;
  /** Start the review (the runtime's `startReview`); throws with a reason when it cannot. */
  start(request: ReviewRequest): Promise<unknown>;
}

export interface ReviewStarter {
  /** Start what is due now. Runs one at a time; a call while one runs waits for it and does nothing more. */
  run(): Promise<void>;
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function reviewStarter(deps: ReviewStarterDeps, store: ReviewRequestStore): ReviewStarter {
  let running: Promise<void> | null = null;

  const pass = async (): Promise<void> => {
    const settings = await deps.settings();
    const due = reviewsToStart(settings, store.view().requests, await deps.sessions(), store.noted());
    // One after another: each start changes how many are at work for the next pass, not this one,
    // and `reviewsToStart` already left room only for these.
    for (const request of due) {
      try {
        await deps.start(request);
      } catch (error) {
        store.note(request.key, reasonOf(error));
      }
    }
  };

  return {
    run: () => {
      running ??= pass()
        .catch((error: unknown) => console.error('[kestrel] could not start reviews', error))
        .finally(() => {
          running = null;
        });
      return running;
    },
  };
}
