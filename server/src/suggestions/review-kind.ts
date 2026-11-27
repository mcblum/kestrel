// The review offer as an optional action (shared/worktree-guests.ts): raised by Kestrel when a
// session's agent opened a pull request itself, where the Create pull request form's question was
// never asked. Start review, Not now, or Don't ask again. An agent may also suggest it; what the
// buttons do is Kestrel's.
import { offersReview, presetSummary, startsReviewAlone, type ModelPreset, type WhoDoesWhat } from '../shared/who-does-what.ts';
import { REVIEW_CARD } from '../shared/worktree-guests.ts';
import { isHostKind } from '../shared/host-terms.ts';
import type { Pressed, Proposal, SuggestionKind } from './registry.ts';

export interface ReviewKindDeps {
  who(): Promise<WhoDoesWhat>;
  /** Who would review this session's work; null when every reviewer wrote some of it or none can run. */
  reviewerFor(sessionId: string): Promise<ModelPreset | null>;
  /**
   * Whether the question is settled for this session: `ever`, a review of it has been started at
   * some time (a request seen again is not offered twice); otherwise only one under way or waiting
   * to start (an agent may ask for another once the last has ended).
   */
  reviewed(sessionId: string, ever: boolean): boolean;
  /**
   * Starts the review, to be posted to the pull request when it ends; while the session is still on
   * a turn, it starts when that turn ends (`waiting`). Throws a reason when it cannot.
   */
  start(sessionId: string): Promise<{ reviewer: string; waiting: boolean }>;
  /** "Don't ask again": the offer is switched off, for the form and the card alike. */
  stopOffering(): Promise<void>;
  /** "Always start reviews": from now on a review starts without the question. */
  startAlone(): Promise<void>;
}

export const REVIEW_KIND = 'review';
const WHERE = 'Settings → Models & roles → Who does what';

export function reviewKind(deps: ReviewKindDeps): SuggestionKind {
  const started = async (sessionId: string): Promise<string> => {
    const review = await deps.start(sessionId);
    return review.waiting ? `Review by ${review.reviewer} starts when this turn ends` : `Review started: ${review.reviewer}`;
  };
  return {
    kind: REVIEW_KIND,
    dismiss: 'skip',
    /**
     * `asked`: the session's agent asked for the review (its `delegate` with the Review role), so one that has
     * ended does not stand in the way. `host` and `number`: the session's open request, when it has one.
     */
    async propose(ctx, payload): Promise<Proposal> {
      const who = await deps.who();
      const alone = startsReviewAlone(who);
      if (!alone && !offersReview(who)) return { type: 'skip', text: 'The user has not asked to be offered reviews. Carry on.' };
      const preset = await deps.reviewerFor(ctx.sessionId);
      if (!preset) return { type: 'skip', text: 'Nobody the user set to review can review this work. Carry on.' };
      if (deps.reviewed(ctx.sessionId, payload.asked !== true)) return { type: 'skip', text: 'This work has already been reviewed, or is being reviewed. Carry on.' };
      if (ctx.messages.some((m) => m.suggestion?.kind === REVIEW_KIND && m.suggestion.state === 'open')) return { type: 'skip', text: 'The user has already been asked about a review. Carry on.' };
      const reviewer = `${preset.name} (${presetSummary(preset)})`;
      return {
        type: 'show',
        draft: {
          title: `Have ${reviewer} review this ${payload.asked === true ? 'work' : 'pull request'}?`,
          reason: 'It reads the work in this worktree without changing it, the session answers its findings, and the result is posted to the pull request. Findings warn; they never block.',
          // The request it is about, where there is one: the card goes once that is merged or closed (shared/request-cards.ts).
          payload: { reviewer, ...(typeof payload.number === 'number' && isHostKind(payload.host) ? { host: payload.host, number: payload.number } : {}) },
          buttons: [
            { id: 'start', label: REVIEW_CARD.start, primary: true },
            { id: 'always', label: REVIEW_CARD.always },
            { id: 'skip', label: REVIEW_CARD.skip },
            { id: 'never', label: REVIEW_CARD.never },
          ],
        },
        // The user's standing "Always start reviews": nothing is asked.
        ...(alone ? { apply: 'start' } : {}),
      };
    },
    async press(ctx, _suggestion, button): Promise<Pressed> {
      if (button === 'start') return { state: 'answered', line: await started(ctx.sessionId) };
      if (button === 'always') {
        // Started first: a review that cannot start leaves the setting as it was.
        const line = await started(ctx.sessionId);
        await deps.startAlone();
        return { state: 'answered', line: `${line}. Reviews now start on their own; change that in ${WHERE}.` };
      }
      if (button === 'never') {
        await deps.stopOffering();
        return { state: 'answered', line: `Reviews will not be offered again. Turn the offer back on in ${WHERE}.` };
      }
      if (button === 'skip') return { state: 'dismissed', line: 'Review skipped' };
      throw new Error(`A review offer has no button "${button}".`);
    },
  };
}
