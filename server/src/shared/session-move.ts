import type { Project, ProjectFolder } from '../model.ts';

// Getting a session to where its work belongs (Matt, 2026-11-20). A session with no project that
// finds the project the work is in asks to move itself there, and keeps its conversation
// (`move_to_project`). A session in a project stays there: in the wrong one, it hands the task off
// and offers to archive itself (`handoff` with `archive_self`). Pure and browser-safe: the words.

/** The card a session with no project raises to move into one. */
export const moveAsk = (where: string, reason: string): { title: string; detail: string } => ({
  title: `Move this session to ${where}?`,
  detail: [reason.trim(), `It keeps this conversation and gets a worktree in ${where}, where it can make changes. Until now it could only read.`].filter(Boolean).join('\n'),
});

/** What the agent is told once the user said yes: the move happens when its turn ends. */
export const moveApproved = (where: string): string =>
  `The user approved. Kestrel moves this session to ${where} as soon as this turn ends: end your turn now, without doing anything else. You are then woken in that project, in a worktree of your own, with this conversation, and carry on there.`;

export const MOVE_DECLINED = 'The user chose not to move this session. Carry on here: answer from what you can read, and use delegate when a change has to be made in a project.';

/** What the user reads in the conversation once it has moved. */
export const movedNotice = (where: string, branch: string | null): string => `Moved to ${where}. This session keeps its conversation and now works ${branch ? `in a worktree of its own, on branch ${branch}` : 'in that folder'}.`;

/** The turn that wakes the session in its new folder. */
export const movedTold = (where: string, directory: string, branch: string | null): string =>
  `[Kestrel] You are now in ${where}: your working folder is ${directory}${branch ? `, a worktree of your own on branch ${branch}` : ''}. It is the same conversation; only where you work changed, and you can now edit files and run commands here. Carry on with what the user asked.`;

/**
 * What the agent is told when the user moved the session themselves (Kestrel's offer, answered
 * after the turn had ended): there is nothing to carry on with, so it is not woken to read this. It
 * goes along with the user's next message (Matt, 2026-11-23: woken, the model thought and replied
 * to a notice that asked nothing of it).
 */
export const movedQuietly = (where: string, directory: string, branch: string | null): string =>
  `[Kestrel] Since your last turn the user moved this session to ${where}: your working folder is now ${directory}${branch ? `, a worktree of your own on branch ${branch}` : ''}, and you can edit files and run commands there. It is the same conversation. This needs no reply or action by itself; go by what the user asks next.`;

/** What the user reads when the move could not be made; the session is as it was. */
export const moveFailed = (where: string, reason: string): string => `This session could not be moved to ${where}: ${reason} It is still where it was.`;

/** The card a session in the wrong project raises: hand the task off, and archive this session. */
export const handoffArchiveAsk = (where: string, title: string): { title: string; detail: string } => ({
  title: `Hand this task to ${where} and archive this session?`,
  detail: `"${title}" is in the wrong project for this work. A new session starts in ${where} with a summary of it, and this one is archived when its turn ends. Archived sessions are kept: Settings → Archived brings one back.`,
});

export const HANDOFF_ARCHIVE_DECLINED = 'The user chose not to hand the task off. Nothing was started and this session stays. Ask what they would like instead.';
export const archivedAfterHandoff = (where: string): string => `Handed off to ${where}. This session is archived; Settings → Archived brings it back.`;
export const notArchived = (reason: string): string => `The task was handed off, but this session was not archived: ${reason}`;

// ---- Kestrel's own offer --------------------------------------------------------------------

/**
 * The one registered project a session with no project worked in, from what its agent ran and read
 * in a turn (`texts`: its commands and tool calls, as written): the project one of whose folders is
 * named there, when no other project's is. Null when it touched none, or more than one: then there
 * is no one place it belongs. The folder is the one named most; a path inside another folder's
 * counts for the inner one.
 */
export function projectWorkedIn(texts: readonly string[], projects: readonly Project[]): { project: Project; folder: ProjectFolder } | null {
  const all = projects.flatMap((project) => project.folders.map((folder) => ({ project, folder })));
  const counts = new Map<string, number>();
  for (const text of texts) {
    // Each place a folder's path is named, as a path of its own: "/code/app" is not named by "/code/app-old".
    for (const { folder } of all) {
      let at = text.indexOf(folder.path);
      while (at !== -1) {
        const after = text[at + folder.path.length];
        const inner = all.some((other) => other.folder.path.length > folder.path.length && other.folder.path.startsWith(`${folder.path}/`) && text.startsWith(other.folder.path, at));
        if (!inner && (after === undefined || !/[A-Za-z0-9_.-]/.test(after))) counts.set(folder.id, (counts.get(folder.id) ?? 0) + 1);
        at = text.indexOf(folder.path, at + folder.path.length);
      }
    }
  }
  const touched = all.filter(({ folder }) => counts.has(folder.id));
  if (touched.length === 0 || new Set(touched.map((t) => t.project.id)).size !== 1) return null;
  return touched.reduce((best, next) => (counts.get(next.folder.id)! > counts.get(best.folder.id)! ? next : best));
}

/** The card Kestrel shows when a session with no project has been working in one project. It does not hold the answer up. */
export const MOVE_OFFER = { move: 'Move it there', skip: 'Not now' } as const;
export const moveOffer = (where: string): { title: string; reason: string } => ({
  title: `Move this session to ${where}?`,
  reason: `It has no project, and what it just did was all in ${where}. Moved there, it keeps this conversation and gets a worktree of its own, so it can make changes; until then it can only read.`,
});
export const MOVE_OFFER_SKIPPED = 'Stays with no project';

