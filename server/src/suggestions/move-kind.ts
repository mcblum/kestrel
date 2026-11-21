// The offer to move a session with no project into the one project it has been working in
// (shared/session-move.ts): raised by Kestrel when such a session's turn ends, so the offer does
// not depend on the agent thinking to ask, and never holds its answer up. Asked once in a session:
// a "Not now" is not asked again. What the button does is Kestrel's (delegation.ts `moveNow`).
import { MOVE_OFFER, MOVE_OFFER_SKIPPED, moveOffer } from '../shared/session-move.ts';
import type { Pressed, Proposal, SuggestionKind } from './registry.ts';

export interface MoveKindDeps {
  /** Where the payload's project and folder are, in words ("Docs · web"); null when they are not a registered project's. */
  where(projectId: unknown, folderId: unknown): Promise<string | null>;
  /** Why this session cannot move itself, or null when it can. */
  refusal(sessionId: string): Promise<string | null>;
  /** Moves the session now and wakes it there; the line to leave in the conversation. Throws a reason when it cannot. */
  move(sessionId: string, projectId: string, folderId: string): Promise<string>;
}

export const MOVE_KIND = 'move';

export function moveKind(deps: MoveKindDeps): SuggestionKind {
  return {
    kind: MOVE_KIND,
    dismiss: 'skip',
    async propose(ctx, payload): Promise<Proposal> {
      const refusal = await deps.refusal(ctx.sessionId);
      if (refusal) return { type: 'refuse', reason: refusal };
      const where = await deps.where(payload.project, payload.folder);
      if (!where) return { type: 'refuse', reason: 'Name a registered project and one of its folders, by id.' };
      if (ctx.messages.some((m) => m.suggestion?.kind === MOVE_KIND)) return { type: 'skip', text: 'The user has already been asked about moving this session. Carry on.' };
      const { title, reason } = moveOffer(where);
      return { type: 'show', draft: { title, reason, payload: { project: payload.project, folder: payload.folder, where }, buttons: [{ id: 'move', label: MOVE_OFFER.move, primary: true }, { id: 'skip', label: MOVE_OFFER.skip }] } };
    },
    async press(ctx, suggestion, button): Promise<Pressed> {
      if (button === 'skip') return { state: 'dismissed', line: MOVE_OFFER_SKIPPED };
      if (button !== 'move') throw new Error(`A move offer has no button "${button}".`);
      return { state: 'answered', line: await deps.move(ctx.sessionId, String(suggestion.payload.project), String(suggestion.payload.folder)) };
    },
  };
}
