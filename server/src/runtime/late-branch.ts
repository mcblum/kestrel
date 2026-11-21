// A new session's branch, renamed to its title once that title is known. The worktree waits for a
// generated title at most TITLE_WAIT_MS (runtime/titling.ts) so starting stays quick; a title that
// comes later used to rename the session only, leaving a branch named after the prompt. Now the
// branch follows, while that is safe: the row still has the worktree and branch it was made with,
// no other session has that branch, and git says nobody else can know the name (branch-rename.ts).
// Anything else keeps the old name, with one log line saying why.
import { branchRenameRefusal, renameBranch } from '../branch-rename.ts';
import { branchName } from '../shared/branch-prefix.ts';
import type { Workspace } from '../workspace.ts';

export interface LateBranchDeps {
  workspace: Pick<Workspace, 'state' | 'setBranch'>;
  log?: (line: string) => void;
}

/** What the session's worktree was made with. */
export interface MadeBranch {
  sessionId: string;
  repo: string;
  worktreePath: string;
  branch: string;
  prefix: string;
}

/** Renames the branch to the session's title now, when it differs and that is safe. Returns the branch it is on. Never throws. */
export async function followTitle(deps: LateBranchDeps, made: MadeBranch): Promise<string> {
  const log = deps.log ?? ((line: string) => console.log(`[kestrel] ${line}`));
  const keep = (why: string) => (log(`branch ${made.branch} of session ${made.sessionId} keeps its name: ${why}`), made.branch);
  try {
    const sessions = (await deps.workspace.state()).sessions;
    const session = sessions.find((s) => s.id === made.sessionId);
    if (!session) return made.branch; // deleted meanwhile
    const wanted = branchName(made.prefix, session.title, made.sessionId);
    if (wanted === made.branch) return made.branch;
    if (session.worktreePath !== made.worktreePath || session.branch !== made.branch) return keep('the session has moved on from it');
    if (sessions.some((s) => s.id !== made.sessionId && s.branch === made.branch)) return keep('another session uses it');
    const refusal = await branchRenameRefusal(made.worktreePath, made.branch, wanted);
    if (refusal) return keep(refusal);
    await renameBranch(made.repo, made.branch, wanted);
    await deps.workspace.setBranch(made.sessionId, wanted);
    return wanted;
  } catch (error) {
    return keep(error instanceof Error ? error.message : String(error));
  }
}
