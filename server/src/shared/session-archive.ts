// `archive_session`: an agent archives a Kestrel session (Matt, 2026-11-24: "please expose a tool within
// Kestrel to archive a Kestrel session so that an agent can do it if it needs to"). Pure and
// browser-safe: whose sessions an agent may archive without asking, and the words.
//
// Archiving is the user's one archive (runtime.ts `archiveSession`: the project's archive script, then
// the workspace's, with its refusals), it never deletes, and it is always undone in a click, which is
// why a session's own work needs no card. Anything else is the user's to say.
import type { Link, WorkspaceState, Workstream } from '../model.ts';
import { leadOf } from './workstreams.ts';

/** The suggestion kind of the line left when an agent archived a session (suggestions/archive-session-kind.ts). */
export const ARCHIVE_SESSION_KIND = 'archive-session';

/**
 * Why `callerId` may archive `targetId` without asking, or `ask` when the user is asked first.
 * - `self`: the session itself; archived when its turn ends.
 * - `started`: a session it started, by the link (`delegate` or `handoff`). `spawn` makes no link,
 *   so a spawned session is asked for.
 * - `workstream`: the caller leads a workstream the target is in.
 * The one rule (Matt to confirm, 2026-11-24): change it here only.
 */
export type ArchiveScope = 'self' | 'started' | 'workstream' | 'ask';

export function archiveScope(
  callerId: string,
  targetId: string,
  links: readonly Pick<Link, 'parentId' | 'childId' | 'kind'>[],
  workstreams: readonly Pick<Workstream, 'sessionIds'>[],
): ArchiveScope {
  if (callerId === targetId) return 'self';
  if (links.some((l) => l.parentId === callerId && l.childId === targetId && (l.kind === 'delegate' || l.kind === 'handoff'))) return 'started';
  if (workstreams.some((w) => leadOf(w) === callerId && w.sessionIds.includes(targetId))) return 'workstream';
  return 'ask';
}

export const ARCHIVE_REASON_MAX = 200;

/** The card the user answers when an agent asks to archive a session that is not its own. */
export const archiveSessionAsk = (title: string, reason: string): { title: string; detail: string } => ({
  title: `Archive “${title}”?`,
  detail: [reason.trim(), 'Another session asks to archive it. Archiving puts it out of sight, with Undo; it is not deleted, and nothing is stopped.'].filter(Boolean).join('\n'),
});

/** The line left in the conversation, with Undo. */
export const archivedLine = (title: string, self: boolean, reason: string): string =>
  `${self ? 'Archived this session' : `Archived “${title}”`}${reason.trim() ? `: ${reason.trim()}` : ''}`;
export const restoredLine = (title: string, self: boolean): string => (self ? 'Restored this session: it is back in the sidebar' : `Restored “${title}”: it is back in the sidebar`);
/** Said in the conversation when a session could not archive itself at the end of its turn. */
export const notArchivedSelf = (reason: string): string => `This session was not archived: ${reason}`;

// ---- what the agent is told -----------------------------------------------------------------

export const ARCHIVE_DECLINED = 'The user chose not to archive that session. Leave it as it is.';
export const selfArchiveLater = 'This session is archived as soon as this turn ends. Say what you did in a sentence, then end your turn without doing anything else.';
export const archivedTold = (title: string, id: string): string => `Archived “${title}” (${id}). The user can undo it from the line in this conversation or from Settings → Archived. Nothing was stopped or deleted.`;
export const ALREADY_ARCHIVED = 'That session is already archived. archive_session never brings one back: restoring is the user\'s, from Settings → Archived.';
/** Added to a refusal from the archive itself (still working, waiting on the user, a failed archive script). */
export const NOT_STOPPED =
  'archive_session never stops, deletes or restores a session: wait until that session has finished its turn and call it again, or tell the user (stopping is theirs, and so is deleting).';

// ---- the window ------------------------------------------------------------------------------

type Archivable = Pick<WorkspaceState, 'sessions' | 'archived'>;

/**
 * Sessions archived since the last push that this window did not archive itself (`archivingHere`):
 * by an agent, by Kestrel's own rule (Always archive after an approval), or after a handoff. The
 * window says so in a toast with Undo, as for its own archive, so ⌘Z brings one back. Not when a
 * project or group was archived in the same push: its sessions went with it, and that was a click.
 */
export function archivedElsewhere(prev: Archivable | null, next: Archivable, archivingHere: ReadonlySet<string>): Archivable['sessions'] {
  if (!prev) return [];
  if (next.archived.projects.length > prev.archived.projects.length || next.archived.groups.length > prev.archived.groups.length) return [];
  const wasInSight = new Set(prev.sessions.map((s) => s.id));
  return next.archived.sessions.filter((s) => wasInSight.has(s.id) && !archivingHere.has(s.id));
}
