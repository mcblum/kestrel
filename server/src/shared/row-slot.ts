// What goes in the slot at the right of a session row in the sidebar (and at the corner of its rail
// button), and what takes its place on hover. Pure: the sidebar draws it (ui/src/components/RowIcons.tsx,
// RowRequest.tsx, RowArchive.tsx).
// - The status dot when there is one: nothing else shows then.
// - Else, left to right: the changed-files icon when the session's worktree differs from its base
//   (amber while files are uncommitted, grey otherwise), then the request icon when it has an open,
//   draft or merged pull or merge request, in its status colour (purple once merged). Either can be
//   alone; a request closed without merging shows nothing. The rail keeps one corner: the request.
// - On hover or keyboard focus, a session that can be archived shows its Archive button instead.
// Also says whether a row should ask the server at all.
import type { SessionState } from '../model.ts';
import { changedFilesText } from './commit-request.ts';
import { primaryPullRequest, pullRequestStatus, type ChangeCounts, type PullRequestLookup } from './details.ts';
import { hostTerms, requestNumber } from './host-terms.ts';
import type { Sourced } from './sourced.ts';

export type RequestTone = ReturnType<typeof pullRequestStatus>['tone'];
/** Amber like the Changes button while files are uncommitted; its grey otherwise. */
export type ChangesTone = 'amber' | 'muted';

export interface RowIcon<Tone> {
  tone: Tone;
  /** "Merge request !12 · Checks running", "3 changed files · 1 uncommitted": the icon's name and tooltip. */
  label: string;
}

export type RowSlot =
  | { kind: 'dot' }
  | { kind: 'icons'; changes: RowIcon<ChangesTone> | null; request: RowIcon<RequestTone> | null }
  | { kind: 'none' };

const NOTHING: RowSlot = { kind: 'none' };

/** How often a drawn sidebar row asks again for its changed files while the window is visible: a glance, like its request. */
export const SIDEBAR_CHANGES_POLL_MS = 180_000;

/**
 * Whether a row asks for its session's requests. A row with a dot shows the dot, so the answer would
 * not be seen; a session with no branch cannot have a request. Folded rows are not drawn at all.
 */
export const asksForRequest = (hasDot: boolean, branch: string | null | undefined): boolean => !hasDot && !!branch;

/** Whether a row asks for its session's changed files: as for requests, and only with a worktree to look in. */
export const asksForChanges = (hasDot: boolean, session: { branch: string | null; worktreePath: string | null }): boolean =>
  asksForRequest(hasDot, session.branch) && !!session.worktreePath;

/** The request icon for a lookup (null when not asked), or null when there is none to show. */
export function requestIcon(lookup: Sourced<PullRequestLookup> | null): RowIcon<RequestTone> | null {
  if (!lookup || lookup.state !== 'ready') return null;
  const pr = primaryPullRequest(lookup.value.pullRequests);
  if (!pr || pr.state === 'closed') return null;
  const terms = hostTerms(lookup.value.host);
  const status = pullRequestStatus(pr);
  return { tone: status.tone, label: `${terms.longTitle} ${requestNumber(terms, pr.number)} · ${status.label}` };
}

/** The changed-files icon for a session's counts (null when not asked), or null when nothing has changed. */
export function changesIcon(counts: Sourced<ChangeCounts> | null): RowIcon<ChangesTone> | null {
  if (!counts || counts.state !== 'ready') return null;
  const label = changedFilesText(counts.value.changed, counts.value.uncommitted);
  if (!label) return null;
  return { tone: counts.value.uncommitted > 0 ? 'amber' : 'muted', label };
}

/** The slot's content, given whether the row has a dot and what its session's sources said (null when not asked). */
export function rowSlot(hasDot: boolean, lookup: Sourced<PullRequestLookup> | null, counts: Sourced<ChangeCounts> | null = null): RowSlot {
  if (hasDot) return { kind: 'dot' };
  const changes = changesIcon(counts);
  const request = requestIcon(lookup);
  return changes || request ? { kind: 'icons', changes, request } : NOTHING;
}

/** A working session, or one waiting on an answer, cannot be archived (the row menu's Archive is disabled then): no hover button. */
export const offersArchive = (state: SessionState, renaming: boolean): boolean => !renaming && state !== 'running' && state !== 'attention';

/** The hover button's name and tooltip. */
export const archiveLabel = (title: string): string => `Archive ${title}`;
