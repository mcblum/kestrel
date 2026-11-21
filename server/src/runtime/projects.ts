// Registering folders as projects. A project is a folder; git is optional.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { mainCheckoutOf, repoRoot } from '../git.ts';
import type { Project, ProjectFolder } from '../model.ts';
import { defaultFolder, folderOf } from '../shared/project-folders.ts';
import { createProject } from '../project-store.ts';
import { Refused, type Workspace } from '../workspace.ts';

/** The project that has this real path among its directories. */
export const projectWithFolder = (projects: readonly Project[], path: string): Project | undefined => projects.find((p) => p.folders.some((f) => f.path === path));

/** The real path of `path` when it is a directory that exists, else null. */
export function realDirectory(path: string): string | null {
  const given = resolve(path);
  return existsSync(given) && statSync(given).isDirectory() ? realpathSync(given) : null;
}

/**
 * Register a directory as a new project of its own (one directory). A git repository must be given
 * by its root. Without a name it is named after the directory, made unique.
 */
export async function registerProject(workspace: Workspace, path: string, name?: string): Promise<Project> {
  const dir = realDirectory(path);
  if (!dir) throw new Refused(`${resolve(path)} is not a directory that exists.`);
  const state = await workspace.state();
  const existing = projectWithFolder([...state.projects, ...state.archived.projects], dir);
  if (existing) throw new Refused(`${dir} is already registered as ${existing.name}.`);
  const root = await repoRoot(dir);
  if (root && root !== dir) throw new Refused(`${dir} is inside a git repository. Choose its root instead: ${root}`);
  const named = name?.trim() || uniqueProjectName(basename(dir), dir, [...state.projects, ...state.archived.projects]);
  return createProject(workspace, { name: named, folders: [dir] });
}

/** What a folder picker needs: the project that has that directory, or a new one-directory project named after it. */
export async function ensureProject(workspace: Workspace, path: string): Promise<{ project: Project; created: boolean }> {
  const dir = realDirectory(path);
  const existing = dir ? projectWithFolder((await workspace.state()).projects, dir) : undefined;
  if (existing) return { project: existing, created: false };
  return { project: await registerProject(workspace, path), created: true };
}

// ---- a folder an agent found on disk ---------------------------------------------------------

/** Agents write `~/Code/x`; nothing else expands it for them. */
export const expandHome = (path: string): string => (path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);

const isInside = (path: string, folder: string) => path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);

/** What an agent's `add_project` path turned out to be. */
export type FoundFolder =
  | { kind: 'registered'; project: Project }
  | { kind: 'new'; path: string; isGit: boolean; /** Set when the path given was a subfolder of the repository. */ note?: string };

/**
 * Check a folder an agent wants to add as a project. Refuses (throws) what must never be a
 * project: a missing path, Kestrel's own data folder, the home folder or the filesystem root,
 * and a linked worktree (its main checkout is the project).
 */
export async function inspectFolder(given: string, ctx: { dataDir: string; projects: readonly Project[] }): Promise<FoundFolder> {
  const raw = expandHome(given.trim());
  if (!raw) throw new Refused('add_project needs a path: the absolute path of the folder.');
  if (!isAbsolute(raw)) throw new Refused(`${given} is not an absolute path. Give the full path, for example /Users/you/Code/project or ~/Code/project.`);
  const dir = realDirectory(raw);
  if (!dir) throw new Refused(`${raw} is not a directory that exists.`);
  const data = realDirectory(ctx.dataDir) ?? resolve(ctx.dataDir);
  if (isInside(dir, data)) throw new Refused(`${dir} is inside Kestrel's own data folder (worktrees, scratch and media), not a project. Add the original project folder instead.`);
  const root = await repoRoot(dir);
  const target = root ?? dir;
  if (target === realDirectory(homedir()) || target === parse(target).root) throw new Refused(`${target} is your ${target === parse(target).root ? 'filesystem root' : 'home folder'}, which is too broad to be a project. Give the repository or folder the work belongs in.`);
  const registered = projectWithFolder(ctx.projects, target);
  if (registered) return { kind: 'registered', project: registered };
  if (root) await refuseWorktree(root, ctx.projects);
  const note = root && root !== dir ? `${dir} is inside the git repository ${root}, so the project is the repository's top level.` : undefined;
  return { kind: 'new', path: target, isGit: root !== null, ...(note ? { note } : {}) };
}

/** A linked worktree is a second checkout of a repository; the repository's main checkout is the project. */
async function refuseWorktree(root: string, projects: readonly Project[]): Promise<void> {
  const main = await mainCheckoutOf(root);
  if (!main) return;
  const known = projectWithFolder(projects, main);
  throw new Refused(
    known
      ? `${root} is a git worktree of ${main}, which is already the project ${known.name}. Use ${known.name}.`
      : `${root} is a git worktree of ${main}, not its main checkout. Call add_project with ${main} instead.`,
  );
}

/** A name no other project has: the folder's name, then with its parent folder, then numbered. */
export function uniqueProjectName(wanted: string, path: string, projects: readonly Project[]): string {
  const taken = new Set(projects.map((p) => p.name.toLowerCase()));
  if (!taken.has(wanted.toLowerCase())) return wanted;
  const withParent = `${wanted} (${basename(dirname(path))})`;
  if (!taken.has(withParent.toLowerCase())) return withParent;
  let n = 2;
  while (taken.has(`${withParent} ${n}`.toLowerCase())) n++;
  return `${withParent} ${n}`;
}

/** The directory a new session in `project` works in: the one asked for, else the default (null when it has none). */
export function chosenFolder(project: Project, folderId: string | null | undefined): ProjectFolder | null {
  if (!folderId) return defaultFolder(project);
  const folder = folderOf(project, folderId);
  if (!folder) throw new Refused(`${project.name} has no such folder. Choose one of its folders again.`);
  return folder;
}
