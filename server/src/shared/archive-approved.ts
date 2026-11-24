// After the user approves somebody else's pull request from a review session, that session's work is
// done, so Kestrel offers to archive it (Matt, 2026-11-24: "when a user approves a PR, it should offer
// to archive the session within a question card"). The offer is a suggestion card
// (suggestions/archive-kind.ts); what it says, and the standing answer kept in Settings → Code reviews
// (`ReviewSettings.afterApproval`), are here. Pure and browser-safe.

/** The suggestion kind of the offer. */
export const ARCHIVE_KIND = 'archive-reviewed';

/** `ask`: the card asks. `always`: the session is archived without asking. `never`: nothing is offered. */
export type AfterApproval = 'ask' | 'always' | 'never';

export const AFTER_APPROVAL: readonly AfterApproval[] = ['ask', 'always', 'never'];

export const AFTER_APPROVAL_LABEL: Record<AfterApproval, string> = {
  ask: 'Ask whether to archive its session',
  always: 'Archive its session',
  never: 'Leave its session where it is',
};

export const isAfterApproval = (v: unknown): v is AfterApproval => AFTER_APPROVAL.includes(v as AfterApproval);

/** The card's buttons, in the house pattern of the other offers. */
export const ARCHIVE_CARD = { archive: 'Archive', always: 'Always archive', skip: 'Not now', never: "Don't ask again" } as const;

/** Where the standing answer is set back to Ask. */
export const AFTER_APPROVAL_WHERE = 'Settings → Code reviews → After an approval';

/** The card: its title and the line under it. `request` is how the request is named ("#12", "!7"). */
export function archiveOffer(request: string): { title: string; reason: string } {
  return {
    title: `Archive this review session?`,
    reason: `Your approval of ${request} was posted, so the review is done. Archiving puts the session out of sight, with Undo; it is not deleted.`,
  };
}

export const ARCHIVED_LINE = 'Archived this session';
export const ALWAYS_LINE = `Archived this session. Sessions are now archived after an approval; change that in ${AFTER_APPROVAL_WHERE}.`;
export const NEVER_LINE = `Archiving will not be offered after an approval again. Turn it back on in ${AFTER_APPROVAL_WHERE}.`;
export const SKIPPED_LINE = 'Kept this session';
export const RESTORED_LINE = 'Restored this session: it is back in the sidebar';
