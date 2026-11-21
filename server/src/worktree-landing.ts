// Throwing a session's worktree away, in two steps: a preview that says exactly what is lost, then
// the act. Git through the CLI, as in git.ts. (Merging a session's branch locally is left to the
// agent: the user asks it.)
//
// Discarding removes the worktree folder, with anything in it that was never committed. The branch
// is kept unless the caller asks for it to be deleted, so committed work can still be found.
import { currentBranch, git, oneAtATime, removeWorktree, splitPaths } from './git.ts';
import { LISTED_COMMITS, type CommitLine, type DiscardPreview } from './shared/landing.ts';

export type { CommitLine, DiscardPreview };

/** `git log` lines written as `<sha> <subject>`. Pure. */
export function parseCommitLines(text: string): CommitLine[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const space = line.indexOf(' ');
      return space < 0 ? { sha: line, subject: '' } : { sha: line.slice(0, space), subject: line.slice(space + 1) };
    });
}

/**
 * The paths in `git status --porcelain=v1 -z --no-renames` output. Pure. Each entry is `XY path`;
 * with renames off there is never a second path.
 */
export function porcelainPaths(text: string): string[] {
  return splitPaths(text)
    .map((entry) => entry.slice(3))
    .filter((path) => path !== '');
}

async function commitsBetween(cwd: string, from: string, to: string): Promise<{ commits: CommitLine[]; total: number }> {
  const [listed, count] = await Promise.all([
    git(cwd, ['log', `--max-count=${LISTED_COMMITS}`, '--format=%H %s', `${from}..${to}`]),
    git(cwd, ['rev-list', '--count', `${from}..${to}`]),
  ]);
  return { commits: parseCommitLines(listed), total: Number(count.trim()) || 0 };
}

/** What discarding the worktree would lose. */
export async function previewDiscard(checkout: string, worktree: string, branch: string | null): Promise<DiscardPreview> {
  const [status, target] = await Promise.all([git(worktree, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all']), currentBranch(checkout)]);
  const unmerged = branch && target && target !== branch ? await commitsBetween(checkout, target, branch) : { commits: [], total: 0 };
  return { branch, worktree, uncommitted: porcelainPaths(status), target, unmerged: unmerged.commits, totalUnmerged: unmerged.total };
}

/**
 * Delete a branch only when nothing is lost with it: git's own `branch -d`, which refuses a branch
 * whose commits are not in the checkout's current branch (or in the branch's upstream). Says
 * whether it went. A branch that is checked out somewhere, or already gone, is left alone.
 */
export async function deleteBranchIfMerged(checkout: string, branch: string): Promise<boolean> {
  return oneAtATime(checkout, async () => {
    const exists = (await git(checkout, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true })).trim() !== '';
    if (!exists) return false;
    await git(checkout, ['branch', '-d', branch], { allowFail: true });
    return (await git(checkout, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true })).trim() === '';
  });
}

/** Forget worktrees whose folders no longer exist (`git worktree prune`). Nothing on disk is removed. */
export async function pruneWorktrees(checkout: string): Promise<void> {
  await oneAtATime(checkout, () => git(checkout, ['worktree', 'prune'], { allowFail: true }));
}

/** Remove the worktree folder, and the branch too when asked. */
export async function discardWorktreeFolder(checkout: string, worktree: string, branch: string | null, deleteBranch: boolean): Promise<void> {
  await removeWorktree(checkout, worktree);
  if (deleteBranch && branch) await oneAtATime(checkout, () => git(checkout, ['branch', '-D', branch]));
}
