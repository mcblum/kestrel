// The line an agent's archive leaves in the conversation, with Undo (shared/session-archive.ts). Raised by
// Kestrel only, and always pressed at once: by the time it is raised the archive was the session's own
// to make, or the user said yes on the approval card (delegation.ts `archiveSession`). Pressing it is
// the archive itself, through the user's one archive, so a refusal (still working, a failed archive
// script) comes back as it is and nothing is shown. Undo restores the session.
import { ARCHIVE_SESSION_KIND, archivedLine, restoredLine } from '../shared/session-archive.ts';
import type { Suggestion } from '../shared/suggestions.ts';
import type { Pressed, Proposal, SuggestionKind } from './registry.ts';

export { ARCHIVE_SESSION_KIND };

export interface ArchiveSessionDeps {
  /** Archive the session as the user's archive does. Throws `Refused` with the reason when it cannot. */
  archive(sessionId: string): Promise<void>;
  restore(sessionId: string): Promise<void>;
}

interface Payload {
  target: string;
  title: string;
  reason: string;
}

const payloadOf = (s: Pick<Suggestion, 'payload'>): Payload => ({
  target: String(s.payload.target ?? ''),
  title: String(s.payload.title ?? ''),
  reason: String(s.payload.reason ?? ''),
});

export function archiveSessionKind(deps: ArchiveSessionDeps): SuggestionKind {
  return {
    kind: ARCHIVE_SESSION_KIND,
    dismiss: 'skip',
    kestrelOnly: true,
    async propose(_ctx, payload): Promise<Proposal> {
      const p = payloadOf({ payload });
      if (!p.target) return { type: 'refuse', reason: 'No session to archive.' };
      return { type: 'show', draft: { title: `Archive “${p.title}”`, payload: { ...p }, buttons: [{ id: 'archive', label: 'Archive', primary: true }] }, apply: 'archive' };
    },
    async press(ctx, suggestion, button): Promise<Pressed> {
      const p = payloadOf(suggestion);
      if (button === 'skip') return { state: 'dismissed', line: 'Kept the session' };
      await deps.archive(p.target);
      return { state: 'answered', line: archivedLine(p.title, p.target === ctx.sessionId, p.reason), undo: { sessionId: p.target } };
    },
    async undo(ctx, suggestion): Promise<string> {
      const p = payloadOf(suggestion);
      await deps.restore(p.target);
      return restoredLine(p.title, p.target === ctx.sessionId);
    },
  };
}
