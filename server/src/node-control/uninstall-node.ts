// The running node's part of `kestrel-node uninstall` (the socket's `uninstall`): refuse while a session's worktree
// has work that is not pushed, naming the sessions (shared/node-uninstall.ts), then leave the account. It deletes
// nothing: the terminal stops the node and deletes the service and the folder once this has answered
// (uninstall-terminal.ts).
import { existsSync } from 'node:fs';
import { unpushedCommits } from '../cleanup/on-merge.ts';
import { uncommittedFiles } from '../git.ts';
import type { Session } from '../model.ts';
import { leftText, unsavedWorkRefusal, type WorktreeWork } from '../shared/node-uninstall.ts';
import type { KestrelHandle } from '../start-server.ts';

export interface GitCounts {
  uncommitted(worktree: string): Promise<number>;
  unpushed(worktree: string, branch: string): Promise<number>;
}

/** The two counts Kestrel already takes before removing a worktree; git that cannot answer counts as work. */
export const gitCounts: GitCounts = {
  uncommitted: (worktree) => uncommittedFiles(worktree).catch(() => 1),
  unpushed: (worktree, branch) => unpushedCommits(worktree, branch),
};

type Owned = Pick<Session, 'id' | 'title' | 'worktreePath' | 'branch' | 'worktreeDiscarded' | 'hostId'>;

/** Every session that owns a worktree still on disk, shown or archived (a guest works in its host's, counted once). */
export async function worktreeWork(sessions: readonly Owned[], counts: GitCounts = gitCounts, onDisk: (path: string) => boolean = existsSync): Promise<WorktreeWork[]> {
  const owners = sessions.filter((s): s is Owned & { worktreePath: string } => !s.hostId && !s.worktreeDiscarded && typeof s.worktreePath === 'string' && onDisk(s.worktreePath));
  return Promise.all(
    owners.map(async (s) => ({
      sessionId: s.id,
      title: s.title,
      uncommitted: await counts.uncommitted(s.worktreePath),
      unpushed: s.branch ? await counts.unpushed(s.worktreePath, s.branch) : 0,
    })),
  );
}

export type UninstallAnswer = { ok: true; message: string } | { ok: false; reason: string };

/** Refuses with the sessions that would lose work; else leaves the account and says so. Never throws. */
export async function leaveAccount(server: Pick<KestrelHandle, 'workspace' | 'connect'>, counts: GitCounts = gitCounts): Promise<UninstallAnswer> {
  try {
    const state = await server.workspace.state();
    const refusal = unsavedWorkRefusal(await worktreeWork([...state.sessions, ...state.archived.sessions], counts));
    if (refusal) return { ok: false, reason: refusal };
    return { ok: true, message: leftText(await server.connect.leaveAccount()) };
  } catch (error) {
    return { ok: false, reason: `Not uninstalled: ${error instanceof Error ? error.message : String(error)}` };
  }
}
