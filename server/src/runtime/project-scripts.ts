// A project's setup and archive scripts, run for a session (shared/project-scripts.ts, 0.0.20):
// setup in a new worktree before its agent starts, shown in the conversation as a step with its
// output and listed in the Commands pane; archive in the worktree before the session is archived.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { AgentEvent } from '../agents/types.ts';
import type { Project, ProjectFolder, Session } from '../model.ts';
import type { ProjectScriptsPrefs } from '../project-scripts/prefs.ts';
import { runScript, scriptVars, type RunScript } from '../project-scripts/run.ts';
import { SCRIPT_LABEL, scriptFailure, setupFailureText, type ScriptOutcome } from '../shared/project-scripts.ts';
import type { Workdir } from './workdir.ts';

/** The setup script did not succeed: the agent is not started, and a reply runs it again. */
export class SetupFailed extends Error {
  constructor(readonly outcome: ScriptOutcome) {
    super(setupFailureText(outcome));
  }
}

export interface ScriptsHost {
  scripts: ProjectScriptsPrefs;
  /** Runs the script; tests pass their own. */
  run?: RunScript;
}

export interface SetupRequest {
  sessionId: string;
  project: Project | null;
  source: ProjectFolder | null;
  where: Workdir;
  signal?: AbortSignal;
  /** The session's variables from the environment settings (project-env/resolve.ts). */
  env?: Record<string, string>;
  /** Where the step and its output go: the session's own event stream. */
  emit: (event: AgentEvent) => void;
}

/**
 * Runs the project's setup script in a worktree that has not had it yet. Returns how it ended, or
 * null when there was nothing to run (no worktree, no script, or it already ran here).
 */
export async function runSetup(host: ScriptsHost, req: SetupRequest): Promise<ScriptOutcome | null> {
  const { project, source, where } = req;
  if (!project || !source || !where.branch || where.setupDone) return null;
  const { setup } = await host.scripts.of(project.id);
  if (!setup) return null;
  const id = `setup-${randomUUID()}`;
  const summary = `Run ${project.name}'s setup script`;
  req.emit({ type: 'tool', id, name: 'Bash', summary, status: 'started', command: setup, label: SCRIPT_LABEL.setup });
  const outcome = await (host.run ?? runScript)({
    kind: 'setup',
    script: setup,
    cwd: where.directory,
    vars: { ...req.env, ...scriptVars({ root: source.path, worktree: where.directory, branch: where.branch, projectName: project.name, sessionId: req.sessionId }) },
    signal: req.signal,
    onOutput: (delta) => req.emit({ type: 'tool-output', id, delta }),
  });
  const failure = scriptFailure('setup', outcome);
  req.emit({ type: 'tool', id, name: 'Bash', summary, status: failure ? 'failed' : 'finished', detail: [failure, outcome.tail].filter(Boolean).join('\n\n') });
  return outcome;
}

/**
 * Runs the project's archive script in the session's worktree, before it is archived. Null when
 * there is nothing to run: no project, no script, or no worktree left on disk.
 */
export async function runArchive(host: ScriptsHost, session: Session, projects: readonly Project[], env: Record<string, string> = {}): Promise<ScriptOutcome | null> {
  const project = projects.find((p) => p.id === session.startedIn);
  if (!project || !session.worktreePath || !session.branch || session.worktreeDiscarded || !existsSync(session.worktreePath)) return null;
  const { archive } = await host.scripts.of(project.id);
  if (!archive) return null;
  const source = project.folders.find((f) => f.id === session.startedFolderId) ?? project.folders.find((f) => f.id === project.defaultFolderId) ?? project.folders[0];
  return (host.run ?? runScript)({
    kind: 'archive',
    script: archive,
    cwd: session.worktreePath,
    vars: { ...env, ...scriptVars({ root: source?.path ?? session.worktreePath, worktree: session.worktreePath, branch: session.branch, projectName: project.name, sessionId: session.id }) },
  });
}
