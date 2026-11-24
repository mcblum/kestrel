// The server's side of shared/working-tree.ts: the same answer, checked against the disk, with the
// branch the worktree is on now (branch-sync.ts). Asked where a session's worktree is looked at:
// its git state and counts, its Changes, its pull requests, the folder a pane opens in.
import { existsSync } from 'node:fs';
import { syncBranch } from './branch-sync.ts';
import { currentBranch } from './git.ts';
import { MAIN_CHECKOUT, sessionFinder, workingTreeOf, type TreeSession, type WorkingTreeAnswer } from './shared/working-tree.ts';

export const WORKTREE_GONE = 'The worktree folder is gone';
const hostTreeGone = (title: string) => `The worktree of "${title}", where this session works, is gone from disk`;

interface TreeState {
  sessions: readonly TreeSession[];
  archived?: { sessions: readonly TreeSession[] };
}

/** `answer`, with a worktree whose folder is gone turned into the reason it is gone. */
export function onDisk(answer: WorkingTreeAnswer, exists: (path: string) => boolean = existsSync): WorkingTreeAnswer {
  const tree = answer.tree;
  if (!tree || exists(tree.path)) return answer;
  return { tree: null, reason: tree.host ? hostTreeGone(tree.host.title) : WORKTREE_GONE, host: tree.host, discarded: false };
}

/** Where the session works, on disk, as the state says now. No git call. */
export function workingTreeIn(state: TreeState, session: TreeSession, exists?: (path: string) => boolean): WorkingTreeAnswer {
  return onDisk(workingTreeOf(session, sessionFinder(state)), exists);
}

/**
 * Where the session works, with the branch the worktree is on now: a rename or a new branch made
 * inside it (by the owner, or by a guest working there) is recorded on the owner, the session the
 * worktree belongs to.
 */
export async function currentWorkingTree(store: { setBranch(id: string, branch: string): Promise<void> }, state: TreeState, session: TreeSession, read: (path: string) => Promise<string | null> = currentBranch): Promise<WorkingTreeAnswer> {
  const answer = workingTreeIn(state, session);
  if (!answer.tree) return answer;
  const { path, branch, ownerId } = answer.tree;
  const now = await syncBranch(store, { id: ownerId, branch, worktreePath: path }, read);
  return now === branch ? answer : { tree: { ...answer.tree, branch: now } };
}

/** Where a session's git actions (creating or merging a pull request) run, or why they cannot. */
export type Checkout = { path: string; branch: string | null; ownerId: string } | { reason: string };

/**
 * The checkout a session's git actions run in: the worktree it works in (its host's for a guest), or
 * the project's main checkout for a session that works there. `folder` is the project directory it
 * works in. Never a main checkout in place of a worktree that is discarded or gone.
 */
export function checkoutIn(state: TreeState, session: TreeSession, folder: { path: string; isGit: boolean } | null | undefined): Checkout {
  if (!folder?.isGit) return { reason: 'This session needs an available Git checkout.' };
  const answer = workingTreeIn(state, session);
  if (answer.tree) return { path: answer.tree.path, branch: answer.tree.branch, ownerId: answer.tree.ownerId };
  if (answer.reason === MAIN_CHECKOUT) return { path: folder.path, branch: null, ownerId: session.id };
  return { reason: `${answer.reason}, so there is no checkout to work in.` };
}
