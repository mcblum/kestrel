// The offer to archive a review session once the user's approval of its pull request was posted
// (shared/archive-approved.ts). Raised by Kestrel only, never by an agent, and only when an approval
// really went up: not on a comment or a request for changes, not when posting failed, and not for a
// request the user dismissed (runtime.ts `approvalPosted`). Archive, Always archive, Not now, or
// Don't ask again; the standing answer is Settings → Code reviews → After an approval.
//
// Archiving is the user's one archive (the project's archive script, then the workspace's
// `setArchived`), so its refusals are its own: a session still working or waiting is not archived,
// and the card stays open with the reason. Undo on the line restores the session.
import { ALWAYS_LINE, ARCHIVE_KIND, archiveOffer, ARCHIVE_CARD, ARCHIVED_LINE, NEVER_LINE, RESTORED_LINE, SKIPPED_LINE, type AfterApproval } from '../shared/archive-approved.ts';
import type { Pressed, Proposal, SuggestionKind } from './registry.ts';

export { ARCHIVE_KIND };

export interface ArchiveKindDeps {
  /** The standing answer: ask, always or never. */
  answer(): Promise<AfterApproval>;
  setAnswer(answer: AfterApproval): Promise<void>;
  /** Archive the session as the user's archive does. Throws `Refused` with the reason when it cannot. */
  archive(sessionId: string): Promise<void>;
  restore(sessionId: string): Promise<void>;
}

export function archiveKind(deps: ArchiveKindDeps): SuggestionKind {
  const archived = async (sessionId: string): Promise<Pressed> => {
    await deps.archive(sessionId);
    return { state: 'answered', line: ARCHIVED_LINE, undo: { sessionId } };
  };
  return {
    kind: ARCHIVE_KIND,
    dismiss: 'skip',
    kestrelOnly: true,
    async propose(ctx, payload): Promise<Proposal> {
      const answer = await deps.answer();
      if (answer === 'never') return { type: 'skip', text: 'The user chose not to be offered archiving after an approval.' };
      if (ctx.messages.some((m) => m.suggestion?.kind === ARCHIVE_KIND && m.suggestion.state === 'open')) return { type: 'skip', text: 'The user is already being asked.' };
      const request = typeof payload.request === 'string' && payload.request ? payload.request : 'the pull request';
      return {
        type: 'show',
        draft: {
          ...archiveOffer(request),
          payload: { request },
          buttons: [
            { id: 'archive', label: ARCHIVE_CARD.archive, primary: true },
            { id: 'always', label: ARCHIVE_CARD.always },
            { id: 'skip', label: ARCHIVE_CARD.skip },
            { id: 'never', label: ARCHIVE_CARD.never },
          ],
        },
        ...(answer === 'always' ? { apply: 'archive' } : {}),
      };
    },
    async press(ctx, _suggestion, button): Promise<Pressed> {
      if (button === 'archive') return archived(ctx.sessionId);
      if (button === 'always') {
        // Archived first: a session that cannot be archived leaves the setting as it was.
        const pressed = await archived(ctx.sessionId);
        await deps.setAnswer('always');
        return { ...pressed, line: ALWAYS_LINE };
      }
      if (button === 'never') {
        await deps.setAnswer('never');
        return { state: 'answered', line: NEVER_LINE };
      }
      if (button === 'skip') return { state: 'dismissed', line: SKIPPED_LINE };
      throw new Error(`An archive offer has no button "${button}".`);
    },
    async undo(ctx): Promise<string> {
      await deps.restore(ctx.sessionId);
      return RESTORED_LINE;
    },
  };
}
