// Renaming a session's branch after its worktree was made: a generated title that came after the
// wait (runtime/titling.ts) names the branch late. A branch is renamed only while nobody else can
// know its name: it is still checked out in its own worktree, nothing was pushed from it, and no
// other branch records it as the one it was cut from. `git branch -m` carries the branch's config
// (its Kestrel base) to the new name and moves the worktree's HEAD with it.
import { git, oneAtATime } from './git.ts';

/** Why `branch` must keep its name, or null when it can be renamed to `to`. Never throws. */
export async function branchRenameRefusal(worktreePath: string, branch: string, to: string): Promise<string | null> {
  const ask = (args: string[]) => git(worktreePath, args, { allowFail: true }).then((out) => out.trim());
  const [checkedOut, upstream, remoteRefs, cutFrom, taken] = await Promise.all([
    ask(['symbolic-ref', '--quiet', '--short', 'HEAD']),
    ask(['config', '--get', `branch.${branch}.remote`]),
    ask(['for-each-ref', '--format=%(refname)', 'refs/remotes/']),
    ask(['config', '--get-regexp', '^branch\\..*\\.kestrelbaseref$']),
    ask(['rev-parse', '--verify', '--quiet', `refs/heads/${to}`]),
  ]);
  if (checkedOut !== branch) return checkedOut ? `its worktree is on ${checkedOut} now` : 'its worktree is not on a branch';
  if (upstream) return 'it has an upstream';
  if (remoteRefs.split('\n').some((ref) => ref.endsWith(`/${branch}`))) return 'it was pushed';
  const children = cutFrom.split('\n').filter((line) => line.split(/\s+/).pop() === branch);
  if (children.length > 0) return 'another branch was cut from it';
  if (taken) return `${to} already exists`;
  return null;
}

/** `git branch -m from to`, queued with the repository's other worktree changes (git.ts `oneAtATime`). */
export async function renameBranch(repo: string, from: string, to: string): Promise<void> {
  await oneAtATime(repo, () => git(repo, ['branch', '-m', from, to]));
}
