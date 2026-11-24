// The lines of a pull request's diff a review comment can be put on (shared/diff-anchors.ts), read in
// the review session's worktree: from where the request left its target branch (the worktree's
// recorded base) to the commit that was reviewed, with the three lines of context a host's diff has.
import { baseOf, currentBranch, git } from '../git.ts';
import { anchorsFromDiff, type DiffAnchors } from '../shared/diff-anchors.ts';

/** `git diff` arguments for the request's diff, whatever the user's git configuration says about prefixes and quoting. Pure. */
export const anchorDiffArgs = (base: string, sha: string): string[] => ['-c', 'core.quotePath=false', 'diff', '-U3', '--find-renames', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', base, sha];

/** The anchors, or undefined when the worktree has no base to compare with. */
export async function reviewAnchors(worktreePath: string, sha: string): Promise<DiffAnchors | undefined> {
  const branch = await currentBranch(worktreePath);
  const base = branch ? await baseOf(worktreePath, branch) : null;
  if (!base || base === sha) return undefined;
  return anchorsFromDiff(await git(worktreePath, anchorDiffArgs(base, sha)));
}
