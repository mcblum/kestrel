// A session with no project moves into one, keeping its conversation (Matt, 2026-11-20): it asked
// about something, found the project the work belongs in, and the user agreed (`move_to_project`,
// delegation.ts). Done between turns, as a fork is: the project's folder gets a worktree for the
// session (or the plain folder itself), the agent's own SDK copies the conversation to work there
// (`fork`, agents/types.ts), and only once both worked is the session's row changed, in one write.
// Anything made before a failure is removed again, so a failed move leaves the session as it was.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createWorktree, git, oneAtATime, removeWorktree } from '../git.ts';
import { AGENT_LABEL, type Project, type ProjectFolder, type Session } from '../model.ts';
import { copiedNotice, copyIntoWorktree, resolveEnv } from '../project-env/resolve.ts';
import { DEFAULT_PERMISSION } from '../shared/permissions.ts';
import { scriptFailure } from '../shared/project-scripts.ts';
import { Refused } from '../workspace.ts';
import type { BringUpHost } from './bring-up.ts';
import { runSetup } from './project-scripts.ts';
import type { Live } from './record.ts';

/** Why this session's conversation cannot be carried into a project, or null when it can. One wording, for the tool and the move. */
export function moveRefusal(host: Pick<BringUpHost, 'adapters'>, session: Pick<Session, 'agent' | 'startedIn'>, rec: Pick<Live, 'agentSessionId' | 'guest'> | undefined): string | null {
  if (session.startedIn) return 'This session is already in a project. A session in a project stays there: when the task belongs in another project, call handoff (with archive_self when this session has nothing left to do).';
  if (rec?.guest) return 'This session works in another session’s worktree and cannot move.';
  if (!host.adapters[session.agent]?.fork) return `${AGENT_LABEL[session.agent]} in Kestrel cannot carry a conversation into another folder. Call handoff instead: a new session starts in the project with your summary.`;
  return null;
}

/**
 * Move `session` into `source`, a folder of `project`. `from`: the folder its conversation is held
 * in now. Returns the folder it works in from here on. Throws `Refused` with the reason, with the
 * session unchanged.
 */
export async function moveToProject(host: BringUpHost, session: Session, rec: Live, project: Project, source: ProjectFolder, from: string): Promise<{ directory: string; branch: string | null }> {
  const refusal = moveRefusal(host, session, rec);
  if (refusal) throw new Refused(refusal);
  const fork = host.adapters[session.agent]!.fork!;
  if (!rec.agentSessionId) throw new Refused('This session never got far enough to have a conversation to move.');
  if (!existsSync(source.path)) throw new Refused(`${source.path} no longer exists. Remove it from ${project.name} and add it again.`);
  if (!source.isGit) host.checkPlainFolderFree(project, source, (await host.workspace.state()).sessions);
  const { start } = source.isGit ? await host.baseRefresh.startFromDefault(source.path, await host.gitDefaults.of(project.id)) : { start: undefined };
  const made = source.isGit ? await createWorktree(source.path, join(host.dataDir, 'worktrees'), session.id, session.title, await host.gitPrefs.prefixForNewBranch(), start) : null;
  const directory = made?.path ?? source.path;
  const undo = async (): Promise<void> => {
    if (!made) return;
    await removeWorktree(source.path, made.path).catch(() => undefined);
    await oneAtATime(source.path, () => git(source.path, ['branch', '-D', made.branch], { allowFail: true })).catch(() => undefined);
  };
  try {
    // As for a new session there: the project's untracked files, then its setup script.
    const envSettings = await host.projectEnv.all();
    if (made) {
      const files = await copyIntoWorktree(envSettings, project.id, source.path, directory);
      const copied = copiedNotice(files.copied);
      if (copied) host.notice(session.id, copied, 'info');
      files.problems.forEach((problem) => host.notice(session.id, problem, 'warning'));
    }
    const environment = await resolveEnv(envSettings, project.id, source.path);
    environment.problems.forEach((problem) => host.notice(session.id, problem, 'warning'));
    const setup = await runSetup(host.projectScripts, { sessionId: session.id, project, source, where: { directory, branch: made?.branch ?? null, base: made?.base ?? null }, env: environment.env, emit: (event) => host.onEvent(session.id, rec, event) });
    const failure = setup && scriptFailure('setup', setup);
    if (failure) throw new Refused(failure);
    const agentSessionId = await fork(rec.agentSessionId, { from, to: directory }).catch((error: unknown) => {
      throw new Refused(`The agent could not carry the conversation over: ${error instanceof Error ? error.message : String(error)}`);
    });
    await host.workspace.moveToProject(session.id, { projectId: project.id, folderId: source.id, worktree: made ? { path: made.path, branch: made.branch } : null });
    // The agent is started again from the copy, in the new folder, with its next turn.
    void rec.handle?.close?.().catch(() => undefined);
    rec.handle = null;
    rec.agentSessionId = agentSessionId;
    rec.base = made?.base ?? null;
    // With no project it could only read; in one it works as a new session there would.
    if (rec.settings.permission === 'readonly') rec.settings = { ...rec.settings, permission: DEFAULT_PERMISSION };
    host.endRunning(session.id);
    await host.upkeep.persist(session.id, rec);
    return { directory, branch: made?.branch ?? null };
  } catch (error) {
    await undo();
    throw error;
  }
}
