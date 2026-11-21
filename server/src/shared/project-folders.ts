// A project's directories (docs/designs/kestrel.md, "Projects with several directories"). Pure and
// browser-safe: the UI imports this too. Every place that needs "the project's directory" asks one of
// these instead of reaching for `folders[0]`.
import type { Project, ProjectFolder, Session } from '../model.ts';

/** Said wherever a project's path would be shown and it has no directory yet. */
export const NO_FOLDER_YET = 'No folder yet';

/** Anything with a project's list of folders, and its explicit default when it has one. */
type WithFolders<F> = { readonly folders: readonly F[]; readonly defaultFolderId?: string | null };

export const hasFolders = (project: WithFolders<unknown>): boolean => project.folders.length > 0;

/**
 * The default folder: the one chosen (`defaultFolderId`), or the first when none is chosen or the
 * chosen one is gone. Null for a project with none. Order carries no other meaning.
 */
export const defaultFolder = <F extends { id: string }>(project: WithFolders<F>): F | null =>
  (project.defaultFolderId ? project.folders.find((f) => f.id === project.defaultFolderId) : undefined) ?? project.folders[0] ?? null;

/** The default's id as it should be stored: a folder of the project, or null for a project with none. */
export const settledDefaultId = (project: WithFolders<{ id: string }>): string | null => defaultFolder(project)?.id ?? null;

/** The project with its default stored explicitly (see `settledDefaultId`). */
export const withSettledDefault = <P extends WithFolders<{ id: string }>>(project: P): P & { defaultFolderId: string | null } => ({ ...project, defaultFolderId: settledDefaultId(project) });

/** The project's folders other than the default, in order. */
export const otherFolders = <F extends { id: string }>(project: WithFolders<F>): F[] => project.folders.filter((f) => f !== defaultFolder(project));

/** One of the project's directories by id, or null. */
export const folderOf = <F extends { id: string }>(project: WithFolders<F>, folderId: string | null | undefined): F | null => (folderId ? (project.folders.find((f) => f.id === folderId) ?? null) : null);

/** A directory's own name: the last part of its path. */
export function folderName(folder: Pick<ProjectFolder, 'path'>): string {
  const parts = folder.path.split('/').filter(Boolean);
  return parts.at(-1) ?? folder.path;
}

/** The path above a directory, or empty for one at the root. */
export function folderParent(folder: Pick<ProjectFolder, 'path'>): string {
  const cut = folder.path.replace(/\/+$/, '').lastIndexOf('/');
  return cut > 0 ? folder.path.slice(0, cut) : '';
}

/**
 * The quiet line under a project page's title: the default folder's path (the page draws it with
 * ~ and cut in the middle) and how many folders there are, or that there is none yet.
 */
export function folderSummary(project: WithFolders<{ id: string; path: string }>): { path: string | null; count: string } {
  const n = project.folders.length;
  if (n === 0) return { path: null, count: NO_FOLDER_YET };
  return { path: defaultFolder(project)!.path, count: `${n} folder${n === 1 ? '' : 's'}` };
}

/** The default directory's path, for lists that show one path per project; null when it has none. */
export const projectPath = (project: WithFolders<{ id: string; path: string }>): string | null => defaultFolder(project)?.path ?? null;

/**
 * The directory a session works in. Its recorded one when it is still in the project; for a session
 * from before (none recorded) in a project with several, the one its worktree was cut from
 * (`repoOf` reads that from the worktree); otherwise the default. Null when the project has none.
 */
export function resolveStartedFolder(
  project: Pick<Project, 'folders'> | null | undefined,
  session: Pick<Session, 'startedFolderId' | 'worktreePath'>,
  repoOf?: (worktreePath: string) => string | null,
): ProjectFolder | null {
  if (!project) return null;
  const recorded = folderOf(project, session.startedFolderId);
  if (recorded) return recorded;
  if (project.folders.length > 1 && session.worktreePath && repoOf) {
    const repo = repoOf(session.worktreePath);
    const cut = repo ? project.folders.find((f) => f.path === repo) : undefined;
    if (cut) return cut;
  }
  return defaultFolder(project);
}

/** How a repository is named in Details: the project, plus the directory when it has several. */
export function repositoryLabel(project: Pick<Project, 'name' | 'folders'>, folder: Pick<ProjectFolder, 'path'> | null): string {
  return folder && project.folders.length > 1 ? `${project.name} · ${folderName(folder)}` : project.name;
}

/** What `lastUsedFolder` reads of a session. */
export interface FolderUse {
  startedIn: string | null;
  createdAt: number;
  folderId?: string | null;
}

/**
 * The directory a new session in this project starts in: the one the newest session there worked
 * in, while it is still in the project; else the default.
 */
export function lastUsedFolder(project: Pick<Project, 'id' | 'folders'>, sessions: readonly FolderUse[]): ProjectFolder | null {
  const newest = sessions.filter((s) => s.startedIn === project.id && folderOf(project, s.folderId)).reduce<FolderUse | null>((best, s) => (!best || s.createdAt > best.createdAt ? s : best), null);
  return folderOf(project, newest?.folderId) ?? defaultFolder(project);
}

/** `ids` reordered: `moving` put just before or after `target`. Unchanged when either is missing or they are the same. */
export function placeFolder(ids: readonly string[], moving: string, target: string, after: boolean): string[] {
  if (moving === target || !ids.includes(moving) || !ids.includes(target)) return [...ids];
  const rest = ids.filter((id) => id !== moving);
  const at = rest.indexOf(target) + (after ? 1 : 0);
  return [...rest.slice(0, at), moving, ...rest.slice(at)];
}

/** True when `given` lists exactly the ids in `current`, each once, in any order. */
export function isFolderPermutation(current: readonly string[], given: readonly string[]): boolean {
  return given.length === current.length && new Set(given).size === given.length && given.every((id) => current.includes(id));
}

/** A project as an older server sends it (one `path`, no `folders`). */
interface LegacyProject {
  id: string;
  name: string;
  path?: string;
  isGit?: boolean;
  folders?: unknown;
  defaultFolderId?: string | null;
}

/**
 * A project in the current shape: one from an older server becomes one folder, with the project's id;
 * one from before explicit defaults keeps the first as its default.
 */
export function normalizeProject(raw: Project | LegacyProject): Project {
  if (Array.isArray(raw.folders)) return withSettledDefault(raw as Project);
  const legacy = raw as LegacyProject;
  const folders = typeof legacy.path === 'string' && legacy.path ? [{ id: legacy.id, path: legacy.path, isGit: legacy.isGit === true }] : [];
  return { id: legacy.id, name: legacy.name, folders, defaultFolderId: folders[0]?.id ?? null };
}
