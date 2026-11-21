// "Create PR" in the session bar, where the pull request chip sits: shown when the session's branch
// has no open or draft pull request (@kestrel/server/session-documents `offersCreatePullRequest`).
// It opens the app's one menu (ContextMenu, kept inside the window by usePopupPlacement) with
// "Manually" and "Generated"; either opens the New PR tab beside Conversation. Says "Create MR" on GitLab.
// With uncommitted changes, "Commit and create" comes first (@kestrel/server/commit-request): it asks
// the agent to commit, and the Generated form opens when that turn ends. While it waits the button
// says "Committing…" and cannot be pressed. Below a separator comes "Remove worktree…"
// (useWorktreeMenu). There is no button for it alone (Matt, 2026-11-18): a worktree is left where it is.
import { useRef } from 'react';
import { ChevronDown, GitPullRequestCreate } from 'lucide-react';
import type { MenuItem } from '@kestrel/server/menu';
import type { GitStatus } from '@kestrel/server/details';
import type { HostTerms } from '@kestrel/server/host-terms';
import type { Sourced } from '@kestrel/server/sourced';
import { COMMIT_AND_CREATE_ID, createPullRequestMenu, uncommittedCount } from '@kestrel/server/commit-request';
import { newPullRequestModeOf } from '@kestrel/server/session-documents';
import { contextMenu } from '../menuState.ts';
import { chooseNewPullRequest } from '../newPullRequest.ts';
import { useCommitRequest } from '../commitRequest.ts';
import { menuOpenFrom } from './controls/anchor.ts';
import type { WorktreeMenu } from './WorktreeConfirmations.tsx';

const MENU_GAP = 4;

interface Props {
  sessionId: string;
  terms: HostTerms;
  /** The session's git status: it says how many files are uncommitted. */
  git: Sourced<GitStatus>;
  /** The worktree's removal, added below a separator; null when the session has no worktree. */
  worktree: WorktreeMenu | null;
}

/** `extra` after `items`, the first of them after a separator. */
export const withSection = (items: MenuItem[], extra: readonly MenuItem[]): MenuItem[] => [...items, ...extra.map((item, i) => (i === 0 ? { ...item, separatorBefore: true } : item))];

export function CreatePullRequestButton({ sessionId, terms, git, worktree }: Props) {
  const button = useRef<HTMLButtonElement>(null);
  const commit = useCommitRequest(sessionId);
  const uncommitted = uncommittedCount(git);
  // The menu closes on any press outside it, this button's own included: that click must not open it again.
  const wasOpen = useRef(false);
  const open = () => {
    const el = button.current;
    if (!el) return;
    contextMenu.openFrom(el, withSection(createPullRequestMenu(uncommitted, commit.blocked !== null), worktree?.items ?? []), {
      gap: MENU_GAP,
      returnFocus: el,
      onPick: (item) => {
        if (worktree?.pick(item)) return;
        if (item.id === COMMIT_AND_CREATE_ID) return commit.send('create');
        const mode = newPullRequestModeOf(item.id);
        if (mode) void chooseNewPullRequest(sessionId, mode);
      },
    });
  };
  return (
    <>
    <button
      ref={button}
      type="button"
      className="pr-create-button"
      aria-haspopup="menu"
      disabled={commit.waiting}
      aria-busy={commit.waiting}
      title={commit.waiting ? 'Waiting for the agent to commit' : `Create a ${terms.long} for this session’s branch`}
      onPointerDown={() => void (wasOpen.current = menuOpenFrom(button.current))}
      onClick={(e) => {
        e.stopPropagation();
        if (wasOpen.current) wasOpen.current = false;
        else open();
      }}
    >
      <GitPullRequestCreate aria-hidden />
      {commit.waiting ? 'Committing…' : `Create ${terms.short}`}
      {!commit.waiting && <ChevronDown aria-hidden className="pr-create-chevron" />}
    </button>
    {worktree?.dialog}
    </>
  );
}
