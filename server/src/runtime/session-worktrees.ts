// A session's worktree and what becomes of it: deleting a session (and what it leaves in its
// repository), discarding a worktree, finding the main checkout one was cut from, Settings →
// Worktrees (runtime/worktree-list.ts), and the startup pass over worktrees removed outside Kestrel.
// Moved out of runtime.ts as it was (0.0.18); the runtime keeps the methods callers use.
import { existsSync } from 'node:fs';
import { removeWorktree } from '../git.ts';
import type { Project, Session, WorkspaceState } from '../model.ts';
import { resolveStartedFolder } from '../shared/project-folders.ts';
import type { BulkRemoval } from '../shared/stale-worktrees.ts';
import type { WorktreeList } from '../worktree-cleanup.ts';
import { deleteBranchIfMerged, discardWorktreeFolder, pruneWorktrees } from '../worktree-landing.ts';
import { worktreeRepo } from '../worktree-repo.ts';
import { Refused } from '../workspace.ts';
import type { RuntimeHost } from './host.ts';
import { WorktreeLists } from './worktree-list.ts';

/** The row note of a session whose worktree folder was removed outside Kestrel. */
const LOST_WORKTREE_NOTE = 'Its worktree folder is gone';

export type WorktreesHost = Pick<RuntimeHost, 'workspace' | 'records' | 'agents' | 'upkeep' | 'background' | 'commands' | 'display' | 'attachments' | 'now' | 'endRunning'>;

export class SessionWorktrees {
  /** Settings → Worktrees: the list, cached a minute, and removing several (runtime/worktree-list.ts). */
  private readonly lists: WorktreeLists;

  constructor(private readonly host: WorktreesHost) {
    this.lists = new WorktreeLists({
      state: () => host.workspace.state(),
      now: () => host.now(),
      mainCheckoutOf: (session, state) => this.mainCheckoutOf(session, state),
      checkoutOf: (id) => this.checkoutOf(id),
      discard: (id) => this.discardWorktree(id, false),
    });
  }

  /**
   * Delete a session for good: its record, its conversation and its links. Its worktree folder is
   * removed too, with anything in it that was never committed; its branch is left in the
   * repository, so committed work can still be found there. A session that is working must be
   * stopped first.
   */
  async deleteSession(sessionId: string): Promise<void> {
    const { workspace, records, upkeep } = this.host;
    // An archived session can be deleted too, so look in both lists.
    const state = await workspace.state();
    const session = [...state.sessions, ...state.archived.sessions].find((s) => s.id === sessionId);
    if (!session) throw new Refused(`No such session: ${sessionId}`);
    if (session.state === 'running' || session.state === 'attention') throw new Refused(`"${session.title}" is still working. Stop it before deleting it.`);
    const rec = records.get(sessionId);
    if (rec) {
      upkeep.cancelRefresh(rec);
      upkeep.cancelNote(rec);
      await rec.handle?.close?.().catch(() => undefined);
      rec.handle = null;
      records.delete(sessionId);
    }
    await this.removeCheckout(session, [...state.projects, ...state.archived.projects].find((p) => p.id === session.startedIn) ?? null);
    this.host.background.forget(sessionId);
    this.host.commands.forget(sessionId);
    this.host.agents.delete(sessionId);
    await workspace.deleteSession(sessionId);
    this.host.display.removeMedia(sessionId);
    this.host.attachments.removeSession(sessionId);
  }

  /**
   * What a deleted session leaves in its repository: the worktree folder goes, and its branch goes
   * too when nothing is lost with it (`deleteBranchIfMerged`); a branch with commits of its own is
   * kept, so committed work can still be found. A failure is logged and the delete carries on.
   */
  private async removeCheckout(session: Session, project: Project | null): Promise<void> {
    const hadWorktree = session.worktreePath !== null || session.worktreeDiscarded === true;
    if (!hadWorktree) return;
    const repo = (session.worktreePath ? worktreeRepo(session.worktreePath) : null) ?? resolveStartedFolder(project, session)?.path;
    if (!repo || !existsSync(repo)) return;
    try {
      if (session.worktreePath && existsSync(session.worktreePath)) await removeWorktree(repo, session.worktreePath);
      if (session.branch) await deleteBranchIfMerged(repo, session.branch);
    } catch (error) {
      console.error('[kestrel] could not clean up after', session.id, error);
    }
  }

  /** End a session's agent process, for a session whose worktree is going or gone: it has nowhere to work. */
  private async endAgent(sessionId: string): Promise<void> {
    const rec = this.host.records.get(sessionId);
    if (rec) {
      this.host.upkeep.cancelRefresh(rec);
      await rec.handle?.close?.().catch(() => undefined);
      rec.handle = null;
    }
    this.host.endRunning(sessionId);
  }

  /**
   * At startup: a session whose worktree folder no longer exists is marked as one whose worktree
   * was removed, with a note that says so, instead of looking usable until a reply is refused.
   * Says how many. Runs before `pruneWorktrees`.
   */
  async markLostWorktrees(): Promise<number> {
    const { workspace } = this.host;
    const state = await workspace.state();
    const missing = [...state.sessions, ...state.archived.sessions].filter((s) => s.worktreePath !== null && !existsSync(s.worktreePath));
    // Sample data names worktrees that never existed; only a session an agent really ran can lose one.
    const lost: Session[] = [];
    for (const s of missing) if ((await workspace.storedDetail(s.id))?.agentSessionId !== undefined) lost.push(s);
    for (const s of lost) {
      await this.endAgent(s.id);
      await workspace.discardWorktree(s.id);
      await workspace.setState(s.id, s.state, LOST_WORKTREE_NOTE);
    }
    return lost.length;
  }

  /** At startup: every project's repository forgets worktrees whose folders are gone. */
  async pruneWorktrees(): Promise<void> {
    const state = await this.host.workspace.state();
    const repos = [...state.projects, ...state.archived.projects].flatMap((p) => p.folders.filter((f) => f.isGit && existsSync(f.path)).map((f) => f.path));
    await Promise.all([...new Set(repos)].map((repo) => pruneWorktrees(repo).catch((error) => console.error('[kestrel] could not prune worktrees in', repo, error))));
  }

  /**
   * A session's worktree and the main checkout it was cut from, for merging it locally or discarding
   * it (worktree-landing.ts). Refused, saying why, when it has none.
   */
  async checkoutOf(sessionId: string): Promise<{ session: Session; checkout: string; worktree: string; branch: string }> {
    const state = await this.host.workspace.state();
    // An archived session still has its worktree, and Settings → Worktrees can remove it.
    const session = state.sessions.find((s) => s.id === sessionId) ?? state.archived.sessions.find((s) => s.id === sessionId);
    if (!session) throw new Refused(`No such session: ${sessionId}`);
    if (session.worktreeDiscarded) throw new Refused(`The worktree of "${session.title}" was already discarded.`);
    if (!session.worktreePath || !session.branch) throw new Refused(`"${session.title}" works in the main checkout, so it has no worktree of its own.`);
    if (!existsSync(session.worktreePath)) throw new Refused(`The worktree ${session.worktreePath} is gone.`);
    const checkout = this.mainCheckoutOf(session, state);
    if (!checkout) throw new Refused(`Kestrel cannot find the main checkout that "${session.title}"’s worktree belongs to.`);
    return { session, checkout, worktree: session.worktreePath, branch: session.branch };
  }

  /** The main checkout a session's worktree was cut from, or null when it cannot be found on disk. */
  private mainCheckoutOf(session: Pick<Session, 'worktreePath' | 'startedIn' | 'startedFolderId'>, state: WorkspaceState): string | null {
    const project = [...state.projects, ...state.archived.projects].find((p) => p.id === session.startedIn) ?? null;
    const checkout = (session.worktreePath ? worktreeRepo(session.worktreePath) : null) ?? resolveStartedFolder(project, session)?.path;
    return checkout && existsSync(checkout) ? checkout : null;
  }

  /** Every session worktree on disk, with its size and whether it is suggested for cleanup (worktree-cleanup.ts). */
  worktrees(refresh = false): Promise<WorktreeList> {
    return this.lists.list(refresh);
  }

  /** Remove several worktrees in one go (shared/stale-worktrees.ts; runtime/worktree-list.ts says which and how). */
  removeWorktrees(which: BulkRemoval): Promise<{ removed: number; failed: { title: string; reason: string }[] }> {
    return this.lists.remove(which);
  }

  /**
   * Remove a session's worktree (and its branch when asked), ending its agent: the session stays in
   * the list, filed where it landed and marked discarded, and can no longer take a reply.
   */
  async discardWorktree(sessionId: string, deleteBranch: boolean): Promise<void> {
    const { session, checkout, worktree, branch } = await this.checkoutOf(sessionId);
    if (session.state === 'running' || session.state === 'attention') throw new Refused(`"${session.title}" is still working. Stop it before discarding its worktree.`);
    await this.endAgent(sessionId);
    await discardWorktreeFolder(checkout, worktree, branch, deleteBranch);
    await this.host.workspace.discardWorktree(sessionId);
    this.lists.forget();
  }
}
