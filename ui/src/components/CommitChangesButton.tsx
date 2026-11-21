// "Commit changes": asks the session's agent to commit its work (commitRequest.ts), the same
// message the Create PR menu and the New PR form send. Shown only while the session has uncommitted
// files; disabled, saying why, while the agent is mid-turn; "Committing…" until that turn ends.
// Count with `uncommittedCount(git)` from @kestrel/server/commit-request.
import { useCommitRequest } from '../commitRequest.ts';

interface Props {
  sessionId: string;
  /** How many files are uncommitted; nothing is drawn at 0. */
  uncommitted: number;
  /** Extra classes for where it is placed; `secondary-button` is always on. */
  className?: string;
}

export function CommitChangesButton({ sessionId, uncommitted, className }: Props) {
  const commit = useCommitRequest(sessionId);
  if (uncommitted < 1) return null;
  return (
    <button
      type="button"
      className={className ? `secondary-button ${className}` : 'secondary-button'}
      disabled={commit.waiting || commit.blocked !== null}
      aria-busy={commit.waiting}
      title={commit.blocked ?? (commit.waiting ? 'Waiting for the agent to commit' : 'Ask the agent to commit this session’s work')}
      onClick={() => commit.send('commit')}
    >
      {commit.waiting ? 'Committing…' : 'Commit changes'}
    </button>
  );
}
