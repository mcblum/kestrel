// The worktrees Kestrel made for sessions, with what each takes on disk and whether it looks stale
// (shared/stale-worktrees.ts), for Settings → Worktrees and the Overview's line. Gathering is
// read-only: git says what is uncommitted and unmerged, `du` says the size. Removing one goes
// through the session runtime's own discard; this file never deletes anything.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { SessionView, WorkspaceState } from './model.ts';
import type { DiscardPreview } from './shared/landing.ts';
import { activityAt } from './shared/session-order.ts';
import { orderRows, removableInBulk, staleReason, summarize, type WorktreeRow, type WorktreeSummary } from './shared/stale-worktrees.ts';

const DU = '/usr/bin/du';
const DU_TIMEOUT_MS = 30_000;
/** How many worktrees are measured and asked about at once. */
const CONCURRENCY = 4;

export interface WorktreeList {
  rows: WorktreeRow[];
  summary: WorktreeSummary;
}

export interface CleanupDeps {
  state(): Promise<WorkspaceState>;
  now(): number;
  /** The main checkout a session's worktree belongs to, or null when it cannot be found. */
  checkoutOf(session: SessionView, state: WorkspaceState): string | null;
  /** What removing the worktree would lose (worktree-landing.ts). */
  preview(checkout: string, worktree: string, branch: string): Promise<DiscardPreview>;
  /** The folder's size in bytes, or null when it could not be measured. */
  measure(path: string): Promise<number | null>;
}

/** A folder's size on disk in bytes (`du -sk`), or null when `du` fails or times out. Never throws. */
export function folderBytes(path: string): Promise<number | null> {
  return new Promise((resolve) =>
    execFile(DU, ['-sk', path], { timeout: DU_TIMEOUT_MS }, (_error, out) => {
      const kilobytes = Number(/^(\d+)/.exec(out ?? '')?.[1]);
      // `du` exits non-zero when it could not read one file and still prints the total: keep the total.
      resolve(Number.isFinite(kilobytes) && (out ?? '').trim() ? kilobytes * 1024 : null);
    }),
  );
}

async function mapLimited<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await run(items[i]!);
      }
    }),
  );
  return out;
}

/** Every session worktree that is still on disk, as a row; archived sessions' worktrees included. */
export async function worktreeList(deps: CleanupDeps): Promise<WorktreeList> {
  const state = await deps.state();
  const now = deps.now();
  const archived = new Set(state.archived.sessions.map((s) => s.id));
  const projects = [...state.projects, ...state.archived.projects];
  const held = [...state.sessions, ...state.archived.sessions].filter((s) => s.worktreePath && s.branch && !s.worktreeDiscarded && existsSync(s.worktreePath));
  const rows = await mapLimited(held, CONCURRENCY, async (session): Promise<WorktreeRow> => {
    const path = session.worktreePath!;
    const checkout = deps.checkoutOf(session, state);
    const [bytes, preview] = await Promise.all([deps.measure(path), checkout ? deps.preview(checkout, path, session.branch!).catch(() => null) : null]);
    const lastActivityAt = activityAt(session);
    const reason = staleReason({ state: session.state, merged: session.request === 'merged', archived: archived.has(session.id), lastActivityAt }, now);
    // What git could not be asked about is not known to be clean: never offered with the others.
    const uncommitted = preview ? preview.uncommitted.length : Number.NaN;
    return {
      sessionId: session.id,
      title: session.title,
      project: projects.find((p) => p.id === (session.landedIn ?? session.startedIn))?.name ?? null,
      path,
      branch: session.branch!,
      bytes,
      reason,
      uncommitted: preview ? preview.uncommitted.length : 0,
      unmerged: preview ? preview.totalUnmerged : 0,
      safe: removableInBulk({ reason, uncommitted }),
      lastActivityAt,
    };
  });
  const ordered = orderRows(rows);
  return { rows: ordered, summary: summarize(ordered) };
}
