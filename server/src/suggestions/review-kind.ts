// The review offer as an optional action (shared/worktree-guests.ts): raised by Kestrel when a
// session's agent opened a pull request itself, where the Create pull request form's question was
// never asked. Start review, Not now, or Don't ask again. An agent may also suggest it; what the
// buttons do is Kestrel's.
import { offersReview, presetSummary, type ModelPreset, type WhoDoesWhat } from '../shared/who-does-what.ts';
import { REVIEW_CARD, type Review } from '../shared/worktree-guests.ts';
import type { Pressed, Proposal, SuggestionKind } from './registry.ts';

export interface ReviewKindDeps {
  who(): Promise<WhoDoesWhat>;
  /** Who would review this session's work; null when every reviewer wrote some of it or none can run. */
  reviewerFor(sessionId: string): Promise<ModelPreset | null>;
  /** Where the session's review stands; null when there has been none. */
  reviewOf(sessionId: string): Review | null;
  /** Starts the review, to be posted to the pull request when it ends. Throws a reason when it cannot. */
  start(sessionId: string): Promise<Review>;
  /** "Don't ask again": the offer is switched off, for the form and the card alike. */
  stopOffering(): Promise<void>;
}

export const REVIEW_KIND = 'review';

export function reviewKind(deps: ReviewKindDeps): SuggestionKind {
  return {
    kind: REVIEW_KIND,
    dismiss: 'skip',
    async propose(ctx): Promise<Proposal> {
      const who = await deps.who();
      if (!offersReview(who)) return { type: 'skip', text: 'The user has not asked to be offered reviews. Carry on.' };
      const preset = await deps.reviewerFor(ctx.sessionId);
      if (!preset) return { type: 'skip', text: 'Nobody the user set to review can review this work. Carry on.' };
      if (deps.reviewOf(ctx.sessionId)) return { type: 'skip', text: 'This work has already been reviewed, or is being reviewed. Carry on.' };
      if (ctx.messages.some((m) => m.suggestion?.kind === REVIEW_KIND && m.suggestion.state === 'open')) return { type: 'skip', text: 'The user has already been asked about a review. Carry on.' };
      const reviewer = `${preset.name} (${presetSummary(preset)})`;
      return {
        type: 'show',
        draft: {
          title: `Have ${reviewer} review this pull request?`,
          reason: 'It reads the work in this worktree without changing it, the session answers its findings, and the result is posted to the pull request. Findings warn; they never block.',
          payload: { reviewer },
          buttons: [
            { id: 'start', label: REVIEW_CARD.start, primary: true },
            { id: 'skip', label: REVIEW_CARD.skip },
            { id: 'never', label: REVIEW_CARD.never },
          ],
        },
      };
    },
    async press(ctx, _suggestion, button): Promise<Pressed> {
      if (button === 'start') {
        const review = await deps.start(ctx.sessionId);
        return { state: 'answered', line: `Review started: ${review.reviewer}` };
      }
      if (button === 'never') {
        await deps.stopOffering();
        return { state: 'answered', line: 'Reviews will not be offered again. Turn the offer back on in Settings → Models & roles → Who does what.' };
      }
      if (button === 'skip') return { state: 'dismissed', line: 'Review skipped' };
      throw new Error(`A review offer has no button "${button}".`);
    },
  };
}
