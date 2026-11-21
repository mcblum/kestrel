// What the Remove worktree confirmation shows (worktree-landing.ts computes it; the UI's dialog
// draws it), and the session bar menu item that opens it. Merging a session's branch locally is
// left to the agent: ask it. Types and plain text only, so the UI can import it.
import type { MenuItem } from './menu.ts';

/** How many commits a preview lists by subject; the total is always given. */
export const LISTED_COMMITS = 20;

export interface CommitLine {
  sha: string;
  subject: string;
}

export interface DiscardPreview {
  branch: string | null;
  worktree: string;
  /** Uncommitted files in the worktree: these are lost. */
  uncommitted: string[];
  /** The branch the main checkout is on, which `unmerged` is counted against; null when detached. */
  target: string | null;
  /** Commits on the session's branch that the target lacks: lost too if the branch is deleted. */
  unmerged: CommitLine[];
  totalUnmerged: number;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** What discarding loses, in one line; null when nothing is lost but the folder. */
export function discardLoss(p: Pick<DiscardPreview, 'uncommitted' | 'totalUnmerged' | 'target'>, deleteBranch: boolean): string | null {
  const lost: string[] = [];
  if (p.uncommitted.length > 0) lost.push(`${plural(p.uncommitted.length, 'uncommitted file')}`);
  if (deleteBranch && p.totalUnmerged > 0) lost.push(`${plural(p.totalUnmerged, 'commit')} not in ${p.target ?? 'the main checkout'}`);
  return lost.length > 0 ? `Lost for good: ${lost.join(' and ')}.` : null;
}

/** The session bar menu's item that opens the confirmation above. */
export const REMOVE_WORKTREE_ID = 'worktree-remove';

/** Why the worktree cannot be removed while the agent works in it. */
export const REMOVE_WHILE_WORKING = 'Stop the session before removing its worktree';

/** The worktree's item in the session bar's git menu: remove it (not while the agent is working). */
export function worktreeMenuItems(working: boolean): MenuItem[] {
  return [{ id: REMOVE_WORKTREE_ID, label: 'Remove worktree…', ...(working ? { disabled: true, hint: REMOVE_WHILE_WORKING } : {}) }];
}
