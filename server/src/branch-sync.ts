// The branch a session's worktree is on NOW. A session is made with a branch name, but the agent
// (or the user, in the terminal) can rename or switch it afterwards, and everything that shows or
// uses the name (the header, Details, the pull request lookup) must follow. Asked whenever the
// worktree is looked at: when its files are refreshed, and when its Details are asked for, so it
// also catches up for a session that has not run since the app started.
import { existsSync } from 'node:fs';
import { currentBranch } from './git.ts';
import type { Session } from './model.ts';

interface BranchStore {
  setBranch(id: string, branch: string): Promise<void>;
}

type Sessionish = Pick<Session, 'id' | 'branch' | 'worktreePath'>;

/**
 * The session's branch after looking at its worktree, recorded when it changed. Sessions without a
 * worktree (or whose worktree is gone), and a detached HEAD, keep what they had. Never throws.
 */
export async function syncBranch(store: BranchStore, session: Sessionish, read: (path: string) => Promise<string | null> = currentBranch, exists: (path: string) => boolean = existsSync): Promise<string | null> {
  if (!session.worktreePath || !exists(session.worktreePath)) return session.branch;
  try {
    const checkedOut = await read(session.worktreePath);
    if (!checkedOut || checkedOut === session.branch) return session.branch;
    await store.setBranch(session.id, checkedOut);
    return checkedOut;
  } catch {
    return session.branch;
  }
}
