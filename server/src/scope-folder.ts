// The one place a pane's scope becomes a folder on disk: the Files view lists it and the terminal
// opens in it. A session works where it always has (its worktree, its plain project folder, or the
// scratch folder); a project page means the project's own folder, its main checkout; a group has
// no folder.
import { homedir } from 'node:os';
import type { Project, WorkspaceState } from './model.ts';
import { defaultFolder, folderOf, hasFolders } from './shared/project-folders.ts';
import { parseScope } from './shared/scope.ts';
import { isAwayProjectId } from './shared/account-projects.ts';
import { MAIN_CHECKOUT } from './shared/working-tree.ts';
import { workingTreeIn } from './working-tree.ts';

export interface ScopeFolderSource {
  /** The folder a session works in, or null when there is no such session. */
  sessionFolder(sessionId: string): Promise<string | null>;
  /** A registered project's folder, or null when there is no such project. */
  projectFolder(projectId: string): Promise<string | null>;
}

/** The folder for a scope key, or null: a group, an unknown session or project, or not a scope at all. */
export async function scopeFolder(key: string, source: ScopeFolderSource): Promise<string | null> {
  const scope = parseScope(key);
  if (!scope) return null;
  if (scope.kind === 'session') return source.sessionFolder(scope.id);
  if (scope.kind === 'project') return source.projectFolder(scope.id);
  return null;
}

/** One of a project's directories (`folderId`, else its default); null for no such project or one with no directory. */
export function projectDirectory(projects: readonly Project[], projectId: string, folderId?: string | null): string | null {
  const project = projects.find((p) => p.id === projectId);
  return project ? ((folderOf(project, folderId) ?? defaultFolder(project))?.path ?? null) : null;
}

/** True when the scope is a project page whose project has no directory yet. */
export function projectWithoutFolder(projects: readonly Project[], key: string): boolean {
  const scope = parseScope(key);
  const project = scope?.kind === 'project' ? projects.find((p) => p.id === scope.id) : undefined;
  return project !== undefined && !hasFolders(project);
}

/** Where a scope's new terminal opens: its folder, or the home folder for a project with no directory yet. */
export async function terminalFolder(projects: readonly Project[], key: string, folderOf: (key: string) => Promise<string | null>): Promise<string | null> {
  return projectWithoutFolder(projects, key) ? homedir() : folderOf(key);
}

/** The folder a session's panes open in, and why when it is not where its work is. */
export interface SessionFolder {
  path: string;
  /** Set when the session's worktree (or its host's, for a guest) is not there to open: why, and where this is instead. */
  note: string | null;
}

/**
 * Where a session works: the worktree it works in (its own, or its host's for a guest; see
 * shared/working-tree.ts), its plain directory, else `scratch`. When it has or had a worktree that
 * cannot be opened (discarded, gone from disk, a guest's host gone), the folder it falls back to
 * comes with a note that says so. Null for no such session.
 */
export function sessionFolderOf(state: Pick<WorkspaceState, 'sessions' | 'projects' | 'archived'>, sessionId: string, scratch: string, exists?: (path: string) => boolean): SessionFolder | null {
  const session = state.sessions.find((s) => s.id === sessionId) ?? state.archived.sessions.find((s) => s.id === sessionId);
  if (!session) return null;
  const answer = workingTreeIn(state, session, exists);
  if (answer.tree) return { path: answer.tree.path, note: null };
  const project = state.projects.find((p) => p.id === session.startedIn);
  const main = project ? folderOf(project, session.folderId)?.path : undefined;
  const note = answer.reason === MAIN_CHECKOUT ? null : `${answer.reason}, so this is ${main ? `the project's main checkout, ${main}` : 'the scratch folder'}.`;
  return { path: main ?? scratch, note };
}

/** Where a session works (`sessionFolderOf`), the folder alone. Null for no such session. */
export function sessionDirectory(state: Pick<WorkspaceState, 'sessions' | 'projects' | 'archived'>, sessionId: string, scratch: string): string | null {
  return sessionFolderOf(state, sessionId, scratch)?.path ?? null;
}

/** Why a scope has no folder, said to the user. */
export function noFolderReason(key: string): string {
  const kind = parseScope(key)?.kind;
  if (kind === 'group') return 'A group has no folder.';
  if (kind === 'project') return isAwayProjectId(parseScope(key)!.id) ? 'This project is on another computer of your account, not this one.' : 'This project has no folder on disk yet.';
  return 'This session has no folder on disk.';
}
