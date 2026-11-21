// SAMPLE DATA, for KESTREL_FAKE=1 only: how some of the seeded sessions' branches (seed.ts) stand
// against their base, so the Details pane can be looked at in every state (up to date, ahead,
// behind, diverged) without real worktrees. Every other branch is asked for as usual, and the
// seeded worktrees do not exist, so those read as unavailable. Never used with a real store.
// A sidebar row's change counts come from the seeded Changes and these uncommitted counts
// (sampleChangeCounts): "Fix partial writes in the search index" shows the changes icon in amber,
// "Keyboard shortcuts" in grey.
import type { ChangeCounts, GitStatus } from './shared/details.ts';
import { ready, type Sourced } from './shared/sourced.ts';

const SAMPLE: Readonly<Record<string, GitStatus>> = {
  'kestrel/please-re-review-this-pr-https-g-ab07f9cf': { ahead: 0, behind: 0, uncommitted: 0, baseLabel: 'mcblum/chore/fix-stupid-lambdas at 758ee2c' },
  'feat/instant-search': { ahead: 3, behind: 0, uncommitted: 0, baseLabel: 'main at 1a2b3c4' },
  'fix/job-retries': { ahead: 0, behind: 5, uncommitted: 0, baseLabel: 'release/2026-11-launch-candidate-with-retries at 3c4d5e6' },
  'feat/auth-polish': { ahead: 2, behind: 4, uncommitted: 0, baseLabel: 'main at 9f8e7d6' },
  'feat/shortcuts': { ahead: 1, behind: 0, uncommitted: 0, baseLabel: 'base 77aa0e1' },
  // Uncommitted files, so Create PR offers "Commit and create" and the New PR form
  // says the changes are uncommitted: "Fix partial writes in the search index" (done, so it can be
  // asked to commit) and "Update API docs" (working, so it cannot yet). A commit turn changes nothing here.
  'kestrel/index-atomic-writes': { ahead: 0, behind: 0, uncommitted: 2, baseLabel: 'main at 4d5e6f7' },
  'docs/api-refresh': { ahead: 0, behind: 0, uncommitted: 2, baseLabel: 'main at 5e6f7a8' },
};

/** The sample status for a branch, or null when it has none. */
export function sampleGitStatus(branch: string | null): Sourced<GitStatus> | null {
  const status = branch ? SAMPLE[branch] : undefined;
  return status ? ready(status) : null;
}

/**
 * A seeded session's change counts: as many changed files as its seeded Changes list, uncommitted as
 * its sample status says (none when it has no sample status). Null when it has no branch.
 */
export function sampleChangeCounts(branch: string | null, changedFiles: number): Sourced<ChangeCounts> | null {
  if (!branch) return null;
  const status = SAMPLE[branch];
  return ready({ changed: changedFiles, uncommitted: status?.uncommitted ?? 0 });
}
