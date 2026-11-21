// Which session worktrees Kestrel suggests cleaning up, and which of those can go without losing
// anything (Matt, 2026-11-18). Kestrel never removes a worktree on its own: it lists what looks
// stale, says why, and the user removes them. Pure; the server gathers the facts
// (worktree-cleanup.ts) and Settings → Worktrees shows the rows.
import type { SessionState } from '../model.ts';

/** A worktree whose session has not been touched for this long is suggested for cleanup. */
export const STALE_AFTER_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * A session used this recently is not suggested, even when its pull request is merged: work often
 * carries on in the same session after a merge (a follow-up fix, a second request), and its
 * worktree must not be offered for removal in the middle of it.
 */
export const RECENTLY_USED_MS = DAY_MS;

/**
 * Why a worktree is suggested:
 * - `merged`: the session's pull request is merged, so its work is on the host, and the session
 *   has not been used for a day.
 * - `archived`: the session was archived.
 * - `idle`: nothing has happened in the session for `STALE_AFTER_DAYS` days.
 */
export type StaleReason = 'merged' | 'archived' | 'idle';

export interface WorktreeFacts {
  state: SessionState;
  /** The session's pull request is merged. */
  merged: boolean;
  archived: boolean;
  /** When the session last did anything, ms since 1970. */
  lastActivityAt: number;
}

/**
 * Why this worktree is suggested for cleanup, or null when it is not. A session that is working or
 * waiting on the user is never suggested, and neither is one used in the last day unless it is
 * archived. The strongest reason wins: merged, then archived, then idle.
 */
export function staleReason(facts: WorktreeFacts, now: number): StaleReason | null {
  if (facts.state === 'running' || facts.state === 'attention') return null;
  // Archiving is the user saying they are done with it, however recently it was used.
  if (facts.archived && !facts.merged) return 'archived';
  if (now - facts.lastActivityAt < RECENTLY_USED_MS) return facts.archived ? 'archived' : null;
  if (facts.merged) return 'merged';
  return now - facts.lastActivityAt >= STALE_AFTER_DAYS * DAY_MS ? 'idle' : null;
}

/**
 * Whether removing it loses nothing: it is suggested for cleanup and has no uncommitted file. Its
 * commits are never at risk either way, since a branch is deleted only when git agrees everything
 * on it is merged, so a branch with unmerged commits is kept. Matt, 2026-11-18: an archived
 * session's clean worktree loses nothing just as a merged one does, and the button must count it.
 * A worktree git could not be asked about has an unknown count (NaN) and is never one of these.
 */
export const removableInBulk = (row: { reason: StaleReason | null; uncommitted: number }): boolean => row.reason !== null && row.uncommitted === 0;

/** One worktree as the list shows it. */
export interface WorktreeRow {
  sessionId: string;
  title: string;
  /** The project's name, or null when the session has none. */
  project: string | null;
  path: string;
  branch: string;
  /** On disk, in bytes; null when it could not be measured. */
  bytes: number | null;
  reason: StaleReason | null;
  /** Uncommitted files: lost if it is removed. */
  uncommitted: number;
  /** Commits its branch has that the main checkout's branch lacks. */
  unmerged: number;
  /** Removing it loses nothing (`removableInBulk`): suggested, and no uncommitted file. */
  safe: boolean;
  lastActivityAt: number;
}

export function reasonText(reason: StaleReason, now: number, lastActivityAt: number): string {
  if (reason === 'merged') return 'Its pull request is merged';
  if (reason === 'archived') return 'Its session is archived';
  const days = Math.floor((now - lastActivityAt) / DAY_MS);
  return `No activity for ${days} day${days === 1 ? '' : 's'}`;
}

/** "3.6 GB", "412 MB", "8 KB": one decimal from a gigabyte up. */
export function sizeText(bytes: number): string {
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const total = (rows: readonly Pick<WorktreeRow, 'bytes'>[]): number => rows.reduce((sum, r) => sum + (r.bytes ?? 0), 0);

export interface WorktreeSummary {
  /** Worktrees suggested for cleanup, and what they take on disk. */
  stale: { count: number; bytes: number };
  /** The ones that lose nothing by going. */
  safe: { count: number; bytes: number };
}

export function summarize(rows: readonly WorktreeRow[]): WorktreeSummary {
  const stale = rows.filter((r) => r.reason !== null);
  const safe = rows.filter((r) => r.safe);
  return { stale: { count: stale.length, bytes: total(stale) }, safe: { count: safe.length, bytes: total(safe) } };
}

/** The Overview's line, or null when there is nothing to suggest: "5 worktrees can be cleaned up (2.1 GB)". */
export function cleanupLine(summary: WorktreeSummary): string | null {
  const { count, bytes } = summary.stale;
  if (count === 0) return null;
  return `${count} worktree${count === 1 ? '' : 's'} can be cleaned up${bytes > 0 ? ` (${sizeText(bytes)})` : ''}`;
}

/** Stale first (merged, archived, idle), then the rest; the largest first within each. */
export function orderRows(rows: readonly WorktreeRow[]): WorktreeRow[] {
  const rank = (r: WorktreeRow) => (r.reason === 'merged' ? 0 : r.reason === 'archived' ? 1 : r.reason === 'idle' ? 2 : 3);
  return [...rows].sort((a, b) => rank(a) - rank(b) || (b.bytes ?? 0) - (a.bytes ?? 0) || a.title.localeCompare(b.title));
}

// ---- removing several at once -------------------------------------------------------------------

/** Which worktrees one press removes: only the ones that lose nothing, or every one that is suggested. */
export type BulkRemoval = 'safe' | 'stale';

export const isBulkRemoval = (value: unknown): value is BulkRemoval => value === 'safe' || value === 'stale';

/** The rows a bulk removal takes. */
export const rowsToRemove = (rows: readonly WorktreeRow[], which: BulkRemoval): WorktreeRow[] => rows.filter((r) => (which === 'safe' ? r.safe : r.reason !== null));

/**
 * What removing every suggested worktree loses for good, to say before it is done: the
 * uncommitted files, and which sessions they are in. Commits are not lost: a branch is deleted
 * only when git agrees everything on it is merged, so a branch with unmerged commits stays.
 */
export function bulkLoss(rows: readonly WorktreeRow[]): { files: number; sessions: string[] } {
  const dirty = rowsToRemove(rows, 'stale').filter((r) => r.uncommitted > 0);
  return { files: dirty.reduce((sum, r) => sum + r.uncommitted, 0), sessions: dirty.map((r) => r.title) };
}
