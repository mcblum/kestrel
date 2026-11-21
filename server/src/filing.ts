// "Where a session is filed" from docs/designs/kestrel.md. Pure functions; no I/O.
import type { Filing, Link, Session } from './model.ts';
import { startLinkOf } from './tree.ts';

export interface GitEvidence {
  /** Project that owns the session's worktree (or the plain folder's shadow history). */
  projectId: string;
  /** True when the worktree differs from its base: uncommitted changes or commits. */
  differsFromBase: boolean;
}

/**
 * Recompute `landedIn` from git evidence. Called when the adapter reports files changed and
 * when the session goes idle or finishes. Evidence of a change sets it; anything else keeps
 * the stored value, so it survives the worktree being discarded or the changes being undone.
 */
export function nextLandedIn(current: string | null, evidence: GitEvidence | null): string | null {
  if (evidence && evidence.differsFromBase) return evidence.projectId;
  return current;
}

type FilingInput = Pick<Session, 'id' | 'startedIn' | 'landedIn' | 'worktreeDiscarded'>;

/**
 * Decide where one session is listed.
 *
 * Order matters and follows the doc:
 *  1. Parent rules win for a session that is both a child and a parent.
 *     A parent that handed off and changed nothing stays listed where it was started: a
 *     conversation the user began in a project does not leave it because the work went on
 *     elsewhere (Matt, 2026-11-18). Only one with no project is not listed in any project.
 *     A parent that handed off after making changes stays under its own landedIn.
 *  2. A child of a handoff or delegate is under landedIn, or "pending" under the project
 *     the handoff started it in.
 *  3. Anything else (including a delegate orchestrator): landedIn, else startedIn, else Unscoped.
 * Git evidence always wins: wherever landedIn is set, that is the project.
 */
export function fileSession(session: FilingInput, links: readonly Link[]): Filing {
  const discarded = session.worktreeDiscarded && session.landedIn !== null;
  const handedOff = links.some((l) => l.parentId === session.id && l.kind === 'handoff');
  const isChild = startLinkOf(session.id, links) !== undefined;

  if (handedOff) {
    if (session.landedIn !== null) return { projectId: session.landedIn, status: 'landed', discarded };
    if (session.startedIn !== null) return { projectId: session.startedIn, status: 'started', discarded: false };
    return { projectId: null, status: 'hidden', discarded: false };
  }
  if (session.landedIn !== null) return { projectId: session.landedIn, status: 'landed', discarded };
  if (isChild && session.startedIn !== null) return { projectId: session.startedIn, status: 'pending', discarded: false };
  if (session.startedIn !== null) return { projectId: session.startedIn, status: 'started', discarded: false };
  return { projectId: null, status: 'unscoped', discarded: false };
}

/** Sessions listed in a project view: derived from filing, never from where they started. */
export function sessionsInProject<T extends FilingInput>(projectId: string, sessions: readonly T[], links: readonly Link[]): T[] {
  return sessions.filter((s) => {
    const f = fileSession(s, links);
    return f.status !== 'hidden' && f.projectId === projectId;
  });
}
