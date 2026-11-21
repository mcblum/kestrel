// Asking a session's agent to commit its work before a pull request is opened from its branch.
// Kestrel never commits by itself: the agent knows which files are its own and writes the message,
// so the request is an ordinary message in the session (COMMIT_REQUEST). This file holds the pure
// rules the UI needs around it: how many files are changed or uncommitted and how that is said,
// whether the agent can take the request now, the Create PR menu with "Commit and create", and when
// the turn that answers the request has ended. Shared with the UI, which has no test runner.
import type { ChatMessage, SessionState } from '../model.ts';
import type { GitStatus } from './details.ts';
import type { HostTerms } from './host-terms.ts';
import type { MenuItem } from './menu.ts';
import { CREATE_PR_MENU } from './session-documents.ts';
import type { Sourced } from './sourced.ts';
import { startsTurn } from './turns.ts';

/** The message sent to the agent: one wording, used by every button that asks it to commit. */
export const COMMIT_REQUEST =
  'Commit the work from this session. Stage only the files that belong to it, write a commit message that follows this repository’s conventions, and do not push.';

/** Why the request cannot be sent while the agent is mid-turn. */
export const AGENT_BUSY_REASON = 'Wait for the agent to finish';

/** The Create PR menu's item that commits first. */
export const COMMIT_AND_CREATE_ID = 'commit-and-create';

/** How many files have uncommitted changes, from the session's git status; 0 while that is loading or unavailable. */
export function uncommittedCount(git: Sourced<Pick<GitStatus, 'uncommitted'>>): number {
  return git.state === 'ready' ? git.value.uncommitted : 0;
}

/** "1 uncommitted file", "3 uncommitted files". */
export const uncommittedFilesText = (count: number): string => `${count} uncommitted ${count === 1 ? 'file' : 'files'}`;

/**
 * What the Changes button's tooltip and a sidebar row's changes icon say: "3 changed files",
 * "1 changed file · 1 uncommitted". Null when no file has changed.
 */
export function changedFilesText(changed: number, uncommitted: number): string | null {
  if (changed < 1) return null;
  return `${changed} changed ${changed === 1 ? 'file' : 'files'}${uncommitted > 0 ? ` · ${uncommitted} uncommitted` : ''}`;
}

/** What the New PR form says while changes are uncommitted, in the host's words. */
export const uncommittedNotice = (terms: HostTerms): string => `You have uncommitted changes. They will not be in this ${terms.long}.`;

/** Whether the agent is mid-turn: working, or stopped on a question the user has not answered. */
export const isAgentBusy = (state: SessionState | undefined, waitingForAnswer: boolean): boolean => state === 'running' || waitingForAnswer;

/** Whether a conversation has a card still waiting for the user's answer. */
export const hasOpenCard = (messages: readonly ChatMessage[] | undefined): boolean => (messages ?? []).some((m) => m.input !== undefined && !m.input.resolved);

/**
 * The Create PR menu. With uncommitted files, "Commit and create" comes first, saying how many
 * (or, while the agent works, why it cannot); with none the menu is Manually and Generated alone.
 */
export function createPullRequestMenu(uncommitted: number, busy: boolean): MenuItem[] {
  const modes: MenuItem[] = CREATE_PR_MENU.map((item) => ({ id: item.id, label: item.label }));
  if (uncommitted < 1) return modes;
  const commit: MenuItem = { id: COMMIT_AND_CREATE_ID, label: 'Commit and create', hint: busy ? AGENT_BUSY_REASON : uncommittedFilesText(uncommitted), ...(busy ? { disabled: true } : {}) };
  return [commit, ...modes.map((item, i) => (i === 0 ? { ...item, separatorBefore: true } : item))];
}

/**
 * Where a commit request is: `sent` until the session is seen working, then `working`. The UI
 * cannot rely on seeing every state (pushes can be merged), so the request's own message saying its
 * turn ended also counts.
 */
export type CommitStage = 'sent' | 'working';

/**
 * The next stage after the session's state was seen. A turn ends when the session, once seen
 * working, is done or interrupted; a question in the middle (attention) is not an end. A failed
 * turn shows as attention and is known to have ended only by `requestEnded`.
 */
export function nextCommitStage(stage: CommitStage, state: SessionState | undefined, requestEnded: boolean): CommitStage | 'ended' {
  if (requestEnded) return 'ended';
  if (state === 'running') return 'working';
  if (stage === 'working' && (state === 'done' || state === 'interrupted')) return 'ended';
  return stage;
}

/** Whether the commit request sent at `since` (ms) or later has had its turn end, by its own message. */
export function commitRequestEnded(messages: readonly ChatMessage[] | undefined, since: number): boolean {
  return (messages ?? []).some((m) => startsTurn(m) && m.text.trim() === COMMIT_REQUEST && (m.sentAt ?? -1) >= since && m.turnEndedAt !== undefined);
}
