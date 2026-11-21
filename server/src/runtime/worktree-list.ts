// Settings → Worktrees, the runtime's side: every session worktree on disk with its size and whether
// it is suggested for cleanup (worktree-cleanup.ts), gathered at most once a minute (it measures
// folders), and removing several in one go (shared/stale-worktrees.ts). Moved out of runtime.ts as it
// was (0.0.18); the runtime keeps the methods callers use and hands them here.
import type { Session, WorkspaceState } from '../model.ts';
import { rowsToRemove, type BulkRemoval } from '../shared/stale-worktrees.ts';
import { folderBytes, worktreeList, type WorktreeList } from '../worktree-cleanup.ts';
import { deleteBranchIfMerged, previewDiscard } from '../worktree-landing.ts';

/** For how long the list of worktrees (it measures every folder) is reused. */
const WORKTREE_LIST_TTL_MS = 60_000;

export interface WorktreeListHost {
  state(): Promise<WorkspaceState>;
  now(): number;
  /** The main checkout a session's worktree was cut from, or null when it cannot be found on disk. */
  mainCheckoutOf(session: Pick<Session, 'worktreePath' | 'startedIn' | 'startedFolderId'>, state: WorkspaceState): string | null;
  /** A session's worktree's checkout and branch; refused, saying why, when it has none. */
  checkoutOf(sessionId: string): Promise<{ checkout: string; branch: string }>;
  /** Remove one session's worktree (its branch stays), ending its agent. */
  discard(sessionId: string): Promise<void>;
}

export class WorktreeLists {
  private cache: { at: number; list: Promise<WorktreeList> } | null = null;

  constructor(private readonly host: WorktreeListHost) {}

  /** Every session worktree on disk, with its size and whether it is suggested for cleanup. */
  list(refresh = false): Promise<WorktreeList> {
    if (!refresh && this.cache && this.host.now() - this.cache.at < WORKTREE_LIST_TTL_MS) return this.cache.list;
    const list = worktreeList({ state: () => this.host.state(), now: () => this.host.now(), checkoutOf: (session, state) => this.host.mainCheckoutOf(session, state), preview: previewDiscard, measure: folderBytes });
    this.cache = { at: this.host.now(), list };
    // A failed gathering is not kept: the next ask tries again.
    list.catch(() => this.cache?.list === list && (this.cache = null));
    return list;
  }

  /** A worktree went: the next list is gathered afresh. */
  forget(): void {
    this.cache = null;
  }

  /**
   * Remove several worktrees in one go: `safe` takes only the ones that lose nothing (suggested, and
   * no uncommitted file); `stale` takes every one that is suggested, which loses any uncommitted files
   * in them (the UI says which first). The list is gathered again now, so each is judged as it
   * stands. A branch is deleted only when git agrees nothing is lost with it; one with unmerged
   * commits is kept. One still in use is never touched. Says how many went, and why any did not.
   */
  async remove(which: BulkRemoval): Promise<{ removed: number; failed: { title: string; reason: string }[] }> {
    const { rows } = await this.list(true);
    let removed = 0;
    const failed: { title: string; reason: string }[] = [];
    for (const row of rowsToRemove(rows, which)) {
      try {
        const { checkout, branch } = await this.host.checkoutOf(row.sessionId);
        await this.host.discard(row.sessionId);
        await deleteBranchIfMerged(checkout, branch);
        removed++;
      } catch (error) {
        failed.push({ title: row.title, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    this.forget();
    return { removed, failed };
  }
}
