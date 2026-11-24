// The Git section of a session's Details: how its branch stands against the commit its worktree was
// cut from (the same base its Changes are taken against). Asked for when the pane needs it, never
// on a timer. Every way it cannot answer is a reason, not a zero. Also the cheaper counts a sidebar
// row asks for (changeCountsOf): how many files changed, how many uncommitted.
import { existsSync } from 'node:fs';
import type { ProjectFolder } from './model.ts';
import type { WorkingTreeAnswer } from './shared/working-tree.ts';
import { aheadBehind, baseOf, changedFileCount, currentBranch, headCommit, isAncestor, uncommittedFiles } from './git.ts';
import type { ChangeCounts, GitStatus } from './shared/details.ts';
import { ready, reasonOf, unavailable, type Sourced } from './shared/sourced.ts';

const SHORT_SHA = 7;

/** What the base is called: "main at 1a2b3c4" when the main checkout's branch holds it, else "base 1a2b3c4". */
async function labelFor(base: string, project: ProjectFolder): Promise<string> {
  const short = base.slice(0, SHORT_SHA);
  const branch = existsSync(project.path) ? await currentBranch(project.path) : null;
  if (branch && (await isAncestor(project.path, base, branch))) return `${branch} at ${short}`;
  return `base ${short}`;
}

/** The worktree and branch to compare, or why there is none (shared/working-tree.ts gives the session's reasons). */
function comparable(tree: WorkingTreeAnswer, project: ProjectFolder | null | undefined): { path: string; branch: string } | { reason: string } {
  if (!project) return { reason: 'No repository' };
  if (!project.isGit) return { reason: 'Plain folder, no change history' };
  if (!tree.tree) return { reason: tree.reason };
  if (!tree.tree.branch) return { reason: 'No branch is recorded for this worktree' };
  return { path: tree.tree.path, branch: tree.tree.branch };
}

/**
 * How many files a session has changed and how many are uncommitted, for its sidebar row: three
 * git calls on top of the base lookup, no diff text. `project` as for `gitStatusOf`.
 */
export async function changeCountsOf(tree: WorkingTreeAnswer, project: ProjectFolder | null | undefined): Promise<Sourced<ChangeCounts>> {
  const at = comparable(tree, project);
  if ('reason' in at) return unavailable(at.reason);
  try {
    const base = await baseOf(at.path, at.branch);
    if (!base) return unavailable('No base commit is recorded for this branch');
    const [changed, uncommitted] = await Promise.all([changedFileCount(at.path, base), uncommittedFiles(at.path)]);
    return ready({ changed, uncommitted });
  } catch (error) {
    return unavailable(reasonOf(error));
  }
}

/** `tree` is where the session works (working-tree.ts); `project` is the directory of its project it works in (shared/project-folders.ts). */
export async function gitStatusOf(tree: WorkingTreeAnswer, project: ProjectFolder | null | undefined): Promise<Sourced<GitStatus>> {
  const at = comparable(tree, project);
  if ('reason' in at || !project) return unavailable('reason' in at ? at.reason : 'No repository');
  try {
    const base = await baseOf(at.path, at.branch);
    if (!base) return unavailable('No base commit is recorded for this branch');
    const counts = await aheadBehind(at.path, base);
    return ready({ ...counts, uncommitted: await uncommittedFiles(at.path), head: await headCommit(at.path), baseLabel: await labelFor(base, project) });
  } catch (error) {
    return unavailable(reasonOf(error));
  }
}
