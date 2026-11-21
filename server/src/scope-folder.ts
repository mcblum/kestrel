// The one place a pane's scope becomes a folder on disk: the Files view lists it and the terminal
// opens in it. A session works where it always has (its worktree, its plain project folder, or the
// scratch folder); a project page means the project's own folder, its main checkout; a group has
// no folder.
import { homedir } from 'node:os';
import type { Project, WorkspaceState } from './model.ts';
import { defaultFolder, folderOf, hasFolders } from './shared/project-folders.ts';
import { parseScope } from './shared/scope.ts';

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

/** Where a session works: its worktree, its plain directory, else `scratch`. Null for no such session. */
export function sessionDirectory(state: Pick<WorkspaceState, 'sessions' | 'projects'>, sessionId: string, scratch: string): string | null {
  const session = state.sessions.find((s) => s.id === sessionId);
  if (!session) return null;
  const project = state.projects.find((p) => p.id === session.startedIn);
  return session.worktreePath ?? (project ? folderOf(project, session.folderId)?.path : undefined) ?? scratch;
}

/** Why a scope has no folder, said to the user. */
export function noFolderReason(key: string): string {
  const kind = parseScope(key)?.kind;
  if (kind === 'group') return 'A group has no folder.';
  if (kind === 'project') return 'This project has no folder on disk yet.';
  return 'This session has no folder on disk.';
}
