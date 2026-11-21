// The session worktrees on disk, with their sizes and which look stale (GET /api/worktrees), held
// once in the app store by route. Settings → Worktrees lists them and the Overview shows one line
// when some can be cleaned up. The server measures folders, so it reuses its answer for a minute;
// after a removal the list is asked for again past that.
import type { BulkRemoval, WorktreeRow, WorktreeSummary } from '@kestrel/server/stale-worktrees';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { fetchResource, useResource } from '../data/resources.ts';
import { act, call } from '../store.ts';

export const WORKTREES_PATH = '/api/worktrees';

export interface WorktreeList {
  rows: WorktreeRow[];
  summary: WorktreeSummary;
}

const NO_SUMMARY: WorktreeSummary = { stale: { count: 0, bytes: 0 }, safe: { count: 0, bytes: 0 } };

const asList = (raw: unknown): Sourced<WorktreeList> => {
  const r = (raw ?? {}) as Partial<WorktreeList>;
  return ready({ rows: Array.isArray(r.rows) ? r.rows : [], summary: r.summary ?? NO_SUMMARY });
};

/** `refreshKey`: something that changes when a worktree may have come or gone (how many sessions have one). */
export function useWorktrees(refreshKey = ''): Sourced<WorktreeList> {
  return useResource(WORKTREES_PATH, asList, refreshKey).value;
}

/** Ask again, past the server's minute: after something was removed. */
export const refreshWorktrees = (): Promise<void> => fetchResource(WORKTREES_PATH, asList, true);

/** Remove several at once: the ones that lose nothing (`safe`), or every suggested one (`stale`). What could not be removed shows in the error line. */
export async function removeWorktrees(which: BulkRemoval): Promise<void> {
  const result = await act(() => call<{ removed: number; failed: { title: string; reason: string }[] }>(`${WORKTREES_PATH}/remove`, { method: 'POST', body: JSON.stringify({ which }) }));
  await refreshWorktrees();
  const first = result?.failed[0];
  if (first) await act(() => Promise.reject(new Error(`${result.failed.length === 1 ? `“${first.title}” was` : `${result.failed.length} worktrees were`} not removed: ${first.reason}`)));
}
