// The session's git state in its top line, kept short: the branch (cut to a short width, the full
// name in the tooltip), lines added and removed when there are changes, and commits ahead and
// behind when known and not zero. Pressing it opens the Details pane.
import { GitBranch } from 'lucide-react';
import { middleTruncate, type GitStatus } from '@kestrel/server/details';
import type { ChangedFile } from '@kestrel/server/model';
import type { Sourced } from '@kestrel/server/sourced';
import { diffCounts } from '@kestrel/server/diff-counts';

/** The branch name is cut to this many characters in the top line. */
export const BRANCH_SUMMARY_CHARS = 22;

function AheadBehind({ git }: { git: Sourced<GitStatus> }) {
  if (git.state !== 'ready' || (git.value.ahead === 0 && git.value.behind === 0)) return null;
  const { ahead, behind } = git.value;
  return (
    <span className="git-summary-counts" aria-label={`${ahead} ahead, ${behind} behind`}>
      {ahead > 0 && <span>↑{ahead}</span>}
      {behind > 0 && <span>↓{behind}</span>}
    </span>
  );
}

interface Props {
  branch: string;
  files: readonly ChangedFile[];
  git: Sourced<GitStatus>;
  onOpen: () => void;
}

export function GitSummary({ branch, files, git, onOpen }: Props) {
  const { added, removed } = diffCounts(files.map((f) => f.diff));
  return (
    <button type="button" className="bar-item git-summary" title={`${branch} · open Details`} aria-label={`Branch ${branch}. Open Details`} onClick={onOpen}>
      <GitBranch aria-hidden />
      <span className="git-summary-branch">{middleTruncate(branch, BRANCH_SUMMARY_CHARS)}</span>
      {files.length > 0 && (
        <span className="git-summary-counts">
          <span className="ctx-added">+{added}</span>
          <span className="ctx-removed">−{removed}</span>
        </span>
      )}
      <AheadBehind git={git} />
    </button>
  );
}
