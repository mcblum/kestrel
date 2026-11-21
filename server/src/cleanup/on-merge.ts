// Cleaning up after a merged pull request (shared/cleanup-policy.ts): what the policy asks for,
// less what would lose work. Each session is cleaned up at most once at a time, in this order: the
// project's archive script (it needs the worktree), the worktree and branch, then the archive
// itself; the session is told what was done and what was kept, and why.
import { git, uncommittedFiles } from '../git.ts';
import type { Session } from '../model.ts';
import { cleanupPlan, cleansUp, mergedNotice, policyFor, type CleanupPlan, type PolicyByScope } from '../shared/cleanup-policy.ts';
import { scriptFailure, type ScriptOutcome } from '../shared/project-scripts.ts';

export interface MergeCleanupDeps {
  policies(): Promise<PolicyByScope>;
  /** The session, when it exists and is not already archived. */
  session(sessionId: string): Promise<Session | null>;
  /** Its worktree and the checkout it was cut from; throws when it has none. */
  checkoutOf(sessionId: string): Promise<{ checkout: string; worktree: string; branch: string }>;
  runArchiveScript(sessionId: string): Promise<ScriptOutcome | null>;
  discardWorktree(sessionId: string, deleteBranch: boolean): Promise<void>;
  archive(sessionId: string): Promise<void>;
  notice(sessionId: string, text: string): void;
}

/** Commits on `branch` that are on no remote-tracking branch; 0 when git cannot say is never assumed: an error counts as "some". */
export async function unpushedCommits(checkout: string, branch: string): Promise<number> {
  try {
    const count = Number((await git(checkout, ['rev-list', '--count', `refs/heads/${branch}`, '--not', '--remotes'])).trim());
    return Number.isInteger(count) ? count : 1;
  } catch {
    return 1;
  }
}

export class MergeCleanup {
  private readonly running = new Map<string, Promise<CleanupPlan | null>>();

  constructor(private readonly deps: MergeCleanupDeps) {}

  /** A session's pull request was merged. Resolves with what was done; null when the policy asks for nothing or the session is gone. Never throws. */
  merged(sessionId: string): Promise<CleanupPlan | null> {
    const held = this.running.get(sessionId);
    if (held) return held;
    const work = this.cleanUp(sessionId)
      .catch((error: unknown) => {
        console.error('[kestrel] could not clean up after a merged pull request', error);
        return null;
      })
      .finally(() => this.running.delete(sessionId));
    this.running.set(sessionId, work);
    return work;
  }

  private async cleanUp(sessionId: string): Promise<CleanupPlan | null> {
    const session = await this.deps.session(sessionId);
    if (!session) return null;
    const policy = policyFor(await this.deps.policies(), session.startedIn);
    if (!cleansUp(policy)) return null;
    const where = await this.deps.checkoutOf(sessionId).catch(() => null);
    const plan = cleanupPlan(policy, {
      working: session.state === 'running' || session.state === 'attention',
      hasWorktree: where !== null,
      uncommitted: where && policy.removeWorktree ? await uncommittedFiles(where.worktree).catch(() => 1) : 0,
      unpushed: where && policy.deleteBranch ? await unpushedCommits(where.checkout, where.branch) : 0,
    });
    // The archive script runs in the worktree, so before the worktree goes; if it fails, nothing is taken away.
    const outcome = plan.archive ? await this.deps.runArchiveScript(sessionId) : null;
    const failure = outcome && scriptFailure('archive', outcome);
    if (failure) {
      this.deps.notice(sessionId, mergedNotice({ ...plan, removeWorktree: false, deleteBranch: false }, `${failure} It was not archived, and its worktree was left as it is.`)!);
      return { ...plan, archive: false, removeWorktree: false, deleteBranch: false };
    }
    if (plan.removeWorktree) await this.deps.discardWorktree(sessionId, plan.deleteBranch);
    const notice = mergedNotice(plan);
    if (notice) this.deps.notice(sessionId, notice);
    if (plan.archive) await this.deps.archive(sessionId);
    return plan;
  }
}
