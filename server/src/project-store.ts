// Creating projects and changing their directories, with every rule checked here, on the server
// (docs/designs/kestrel.md, "Projects with several directories"):
//  - a project needs a name, unique in any case;
//  - a directory must exist; a git repository is added by its top level;
//  - a directory belongs to one project, once (compared by real path);
//  - a directory that live session worktrees were cut from cannot be removed;
//  - a project may have no directory at all.
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { repoRoot } from './git.ts';
import type { Project, ProjectFolder, Session } from './model.ts';
import type { Persistence } from './persistence/types.ts';
import { expandHome, realDirectory } from './runtime/projects.ts';
import { folderName, folderOf, isFolderPermutation, resolveStartedFolder } from './shared/project-folders.ts';
import { Refused, type Workspace } from './workspace.ts';
import { worktreeRepo } from './worktree-repo.ts';

export const MAX_PROJECT_NAME = 80;
export const MAX_FOLDERS_PER_PROJECT = 20;

/** A refusal about one input, so the page can show it beside that field or row. */
export class FieldRefused extends Refused {
  constructor(
    message: string,
    /** `name`, or the path as the user gave it. */
    readonly field: string,
  ) {
    super(message);
  }
}

/** The name as it will be stored, or a refusal: required, and no other project's in any case. */
export function checkName(raw: string, projects: readonly Project[], exceptId?: string): string {
  const name = raw.trim().slice(0, MAX_PROJECT_NAME);
  if (!name) throw new FieldRefused('A project needs a name.', 'name');
  const taken = projects.find((p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase());
  if (taken) throw new FieldRefused(`There is already a project called ${taken.name}.`, 'name');
  return name;
}

/** Where a real path already is, among every project's directories. */
function holderOf(path: string, projects: readonly Project[]): Project | undefined {
  return projects.find((p) => p.folders.some((f) => f.path === path));
}

/** The real path of a directory the user gave, or a refusal: it must exist. */
export function existingFolder(given: string): string {
  const asked = expandHome(given.trim());
  const dir = asked ? realDirectory(asked) : null;
  if (!dir) throw new FieldRefused(`${asked ? resolve(asked) : 'That'} is not a folder that exists.`, given);
  return dir;
}

/** A refusal when a project already has the real directory `dir`. */
export function refuseHeld(dir: string, given: string, projects: readonly Project[], into?: Project): void {
  const holder = holderOf(dir, projects);
  if (holder) throw new FieldRefused(holder.id === into?.id ? `${dir} is already in this project.` : `${dir} is already in the project ${holder.name}.`, given);
}

/** `dir` as a project folder, or a refusal when it is inside a git repository but not its top level. */
export async function gitChecked(dir: string, given: string): Promise<Omit<ProjectFolder, 'id'>> {
  const root = await repoRoot(dir);
  if (root && root !== dir) throw new FieldRefused(`${dir} is inside a git repository. Add its top level instead: ${root}`, given);
  return { path: dir, isGit: root !== null };
}

/** A directory the user gave, checked: it exists, it is a repository's top level if it is in one, and no project has it yet. */
export async function checkFolder(given: string, projects: readonly Project[], into?: Project): Promise<Omit<ProjectFolder, 'id'>> {
  const dir = existingFolder(given);
  refuseHeld(dir, given, projects, into);
  return gitChecked(dir, given);
}

/** Each directory checked against the projects and the ones before it in the list. */
async function checkFolders(given: readonly string[], projects: readonly Project[]): Promise<ProjectFolder[]> {
  if (given.length > MAX_FOLDERS_PER_PROJECT) throw new Refused(`A project can have at most ${MAX_FOLDERS_PER_PROJECT} folders.`);
  const out: ProjectFolder[] = [];
  for (const path of given) {
    const folder = await checkFolder(path, projects);
    if (out.some((f) => f.path === folder.path)) throw new FieldRefused(`${folder.path} is listed twice.`, path);
    out.push({ id: randomUUID(), ...folder });
  }
  return out;
}

/**
 * A new project with a name and zero or more folders, in that order. `defaultFolder` is one of the
 * given paths, as given; without it (or when it is not among them) the first is the default.
 */
export async function createProject(workspace: Workspace, input: { name: string; folders?: readonly string[]; defaultFolder?: string }): Promise<Project> {
  return workspace.changeProjects(async (tx) => {
    const projects = await tx.listProjects();
    const name = checkName(input.name, projects);
    const given = input.folders ?? [];
    const folders = await checkFolders(given, projects);
    const chosen = input.defaultFolder === undefined ? -1 : given.indexOf(input.defaultFolder);
    return insertNewProject(tx, name, folders, chosen);
  });
}

/**
 * Store a project whose name and folders are already checked: how a project is made by hand, one at
 * a time or several at once (project-batch.ts). Without a chosen default (`chosen` -1) the first
 * folder is the default.
 */
export async function insertNewProject(tx: Persistence, name: string, folders: readonly ProjectFolder[], chosen = -1): Promise<Project> {
  const project: Project = { id: randomUUID(), name, folders: [...folders], defaultFolderId: folders[chosen]?.id ?? folders[0]?.id ?? null };
  await tx.insertProject(project);
  return project;
}

/** Make one of the project's folders its default. Order is untouched. Returns the project. */
export async function setDefaultFolder(workspace: Workspace, projectId: string, folderId: string): Promise<Project> {
  return workspace.changeProjects(async (tx) => {
    const { project } = await projectIn(tx, projectId);
    if (!folderOf(project, folderId)) throw new Refused('That folder is not in this project.');
    await tx.setDefaultFolder(projectId, folderId);
    return reread(tx, projectId);
  });
}

async function projectIn(tx: Persistence, projectId: string): Promise<{ project: Project; projects: Project[] }> {
  const projects = await tx.listProjects();
  const project = projects.find((p) => p.id === projectId);
  if (!project) throw new Refused('No such project.');
  return { project, projects };
}

const reread = async (tx: Persistence, projectId: string): Promise<Project> => (await projectIn(tx, projectId)).project;

/** Add a directory after the project's others. Returns the project. */
export async function addFolder(workspace: Workspace, projectId: string, path: string): Promise<Project> {
  return workspace.changeProjects(async (tx) => {
    const { project, projects } = await projectIn(tx, projectId);
    if (project.folders.length >= MAX_FOLDERS_PER_PROJECT) throw new Refused(`A project can have at most ${MAX_FOLDERS_PER_PROJECT} folders.`);
    await tx.insertFolder(projectId, { id: randomUUID(), ...(await checkFolder(path, projects, project)) });
    return reread(tx, projectId);
  });
}

/** Sessions of the project whose worktree, still kept, was cut from this directory. */
export function liveWorktreesIn(project: Project, folderId: string, sessions: readonly Session[], repoOf = worktreeRepo): Session[] {
  return sessions.filter((s) => s.startedIn === project.id && s.worktreePath && !s.worktreeDiscarded && resolveStartedFolder(project, s, repoOf)?.id === folderId);
}

/** Take a directory out of a project. Refused while session worktrees cut from it are kept. Returns the project. */
export async function removeFolder(workspace: Workspace, projectId: string, folderId: string): Promise<Project> {
  return workspace.changeProjects(async (tx) => {
    const { project } = await projectIn(tx, projectId);
    const folder = project.folders.find((f) => f.id === folderId);
    if (!folder) throw new Refused('That folder is not in this project.');
    const live = liveWorktreesIn(project, folderId, await tx.listSessions()).length;
    if (live > 0) throw new FieldRefused(`${live} session${live === 1 ? ' still has its worktree' : 's still have their worktrees'} in ${folderName(folder)}. Delete ${live === 1 ? 'it' : 'them'} first, or keep the folder.`, folder.path);
    await tx.deleteFolder(projectId, folderId);
    return reread(tx, projectId);
  });
}

/** Put the project's folders in this order (the default is unchanged). `ids` must list each once. */
export async function reorderFolders(workspace: Workspace, projectId: string, ids: readonly string[]): Promise<Project> {
  return workspace.changeProjects(async (tx) => {
    const { project } = await projectIn(tx, projectId);
    if (!isFolderPermutation(project.folders.map((f) => f.id), ids)) throw new Refused('The folders changed. Try again.');
    await tx.setFolderOrder(projectId, ids);
    return reread(tx, projectId);
  });
}
