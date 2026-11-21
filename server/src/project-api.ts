// HTTP routes for projects and their directories. Shaped like organize-api.ts: the caller hands over
// the path parts and a body reader, and gets an answer, or null when the path is not one of these.
// Bad input is a 400; a rule that refuses (project-store.ts) is a 409 with `field` naming the input
// it concerns (`name`, or the path as given), so the page can show it beside that field.
//
//   POST   /api/projects/create               { name, folders?: string[], defaultFolder?: string }   201 Project
//   POST   /api/projects                      { path, name? }                201 Project (one directory; older callers)
//   POST   /api/projects/ensure               { path }                       200 { project, created }
//   POST   /api/projects/check-folder         { path }                       200 { path, isGit } (nothing saved)
//   POST   /api/projects/:id/folders          { path }                       201 Project
//   DELETE /api/projects/:id/folders/:folderId                               200 Project
//   POST   /api/projects/:id/folders/order    { folders: string[] }          200 Project (a permutation)
//   POST   /api/projects/:id/folders/default  { folderId }                   200 Project
//   GET    /api/projects/:id/changes[?folder=id]                             200 ProjectChanges
//   POST   /api/projects/list-folder          { path }                       200 FolderListing (the folders inside it)
//   POST   /api/projects/create-many          { folders: string[] }          200 { results: BatchOutcome[] }
// The last two add several projects from one parent folder (folder-listing.ts, project-batch.ts);
// their refusals (a path that is not a readable folder, a batch too large) are plain 409s.
import { listFolder } from './folder-listing.ts';
import { projectChanges } from './git.ts';
import { createProjects } from './project-batch.ts';
import { addFolder, checkFolder, createProject, FieldRefused, MAX_FOLDERS_PER_PROJECT, MAX_PROJECT_NAME, removeFolder, reorderFolders, setDefaultFolder } from './project-store.ts';
import type { SessionRuntime } from './runtime.ts';
import { defaultFolder, folderOf } from './shared/project-folders.ts';
import type { Workspace } from './workspace.ts';

export type ProjectAnswer = { status: number; body?: unknown };
type ReadBody = () => Promise<Record<string, unknown>>;

const MAX_PATH = 1000;
const MAX_ID = 100;

const bad = (error: string): ProjectAnswer => ({ status: 400, body: { error } });
const refused = (error: FieldRefused): ProjectAnswer => ({ status: 409, body: { error: error.message, field: error.field } });

const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null);

/** A list of paths as sent, or null when it is not one. */
function paths(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_FOLDERS_PER_PROJECT) return null;
  const out = value.map((v) => text(v, MAX_PATH));
  return out.every((v): v is string => v !== null) ? out : null;
}

/** A list of ids as sent, or null when it is not one. */
function ids(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_FOLDERS_PER_PROJECT) return null;
  const out = value.map((v) => text(v, MAX_ID));
  return out.every((v): v is string => v !== null) ? out : null;
}

/** Answers a project route, or null when the path is not one. A FieldRefused comes back as a 409 with its field. */
export async function projectRoute(parts: readonly string[], method: string, url: URL, readBody: ReadBody, workspace: Workspace, runtime: SessionRuntime | undefined): Promise<ProjectAnswer | null> {
  if (parts[1] !== 'projects') return null;
  try {
    return await route(parts, method, url, readBody, workspace, runtime);
  } catch (error) {
    if (error instanceof FieldRefused) return refused(error);
    throw error;
  }
}

async function route(parts: readonly string[], method: string, url: URL, readBody: ReadBody, workspace: Workspace, runtime: SessionRuntime | undefined): Promise<ProjectAnswer | null> {
  if (method === 'POST' && parts.length === 3 && parts[2] === 'create') return create(await readBody(), workspace);
  if (runtime && method === 'POST' && parts.length === 2) return registerOne(await readBody(), runtime);
  if (runtime && method === 'POST' && parts.length === 3 && parts[2] === 'ensure') {
    const path = text((await readBody()).path, MAX_PATH);
    return path ? { status: 200, body: await runtime.ensureProject(path) } : bad('path is required');
  }
  if (method === 'POST' && parts.length === 3 && parts[2] === 'check-folder') {
    const path = text((await readBody()).path, MAX_PATH);
    if (!path) return bad('path is required');
    const state = await workspace.state();
    return { status: 200, body: await checkFolder(path, [...state.projects, ...state.archived.projects]) };
  }
  if (method === 'POST' && parts.length === 3 && parts[2] === 'list-folder') return listing(await readBody(), workspace);
  if (method === 'POST' && parts.length === 3 && parts[2] === 'create-many') return createMany(await readBody(), workspace);
  if (parts.length < 4 || parts[2]!.length > MAX_ID) return null;
  const id = parts[2]!;
  if (method === 'GET' && parts.length === 4 && parts[3] === 'changes') return changes(id, url, workspace);
  if (parts[3] !== 'folders') return null;
  if (method === 'POST' && parts.length === 4) {
    const path = text((await readBody()).path, MAX_PATH);
    return path ? { status: 201, body: await addFolder(workspace, id, path) } : bad('path is required');
  }
  if (method === 'POST' && parts.length === 5 && parts[4] === 'order') {
    const order = ids((await readBody()).folders);
    return order ? { status: 200, body: await reorderFolders(workspace, id, order) } : bad('folders must be the list of the project’s folder ids, in their new order');
  }
  if (method === 'POST' && parts.length === 5 && parts[4] === 'default') {
    const folderId = text((await readBody()).folderId, MAX_ID);
    return folderId ? { status: 200, body: await setDefaultFolder(workspace, id, folderId) } : bad('folderId is required');
  }
  if (method === 'DELETE' && parts.length === 5 && parts[4]!.length <= MAX_ID) return { status: 200, body: await removeFolder(workspace, id, parts[4]!) };
  return null;
}

async function create(body: Record<string, unknown>, workspace: Workspace): Promise<ProjectAnswer> {
  if (typeof body.name !== 'string' || body.name.length > MAX_PROJECT_NAME * 2) return bad('name must be text');
  const folders = paths(body.folders);
  if (!folders) return bad(`folders must be a list of at most ${MAX_FOLDERS_PER_PROJECT} paths`);
  const chosen = body.defaultFolder === undefined ? undefined : text(body.defaultFolder, MAX_PATH);
  if (chosen === null) return bad('defaultFolder must be one of the folders');
  return { status: 201, body: await createProject(workspace, { name: body.name, folders, ...(chosen ? { defaultFolder: chosen } : {}) }) };
}

async function listing(body: Record<string, unknown>, workspace: Workspace): Promise<ProjectAnswer> {
  const path = text(body.path, MAX_PATH);
  if (!path) return bad('path is required: the full path of the folder to look in');
  const state = await workspace.state();
  return { status: 200, body: await listFolder(path, [...state.projects, ...state.archived.projects]) };
}

async function createMany(body: Record<string, unknown>, workspace: Workspace): Promise<ProjectAnswer> {
  const given = Array.isArray(body.folders) ? body.folders.map((v) => text(v, MAX_PATH)) : null;
  if (!given || !given.every((v): v is string => v !== null)) return bad('folders must be a list of folder paths');
  return { status: 200, body: { results: await createProjects(workspace, given) } };
}

async function registerOne(body: Record<string, unknown>, runtime: SessionRuntime): Promise<ProjectAnswer> {
  const path = text(body.path, MAX_PATH);
  if (!path) return bad('path is required');
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, MAX_PROJECT_NAME) : undefined;
  return { status: 201, body: await runtime.registerProject(path, name) };
}

async function changes(id: string, url: URL, workspace: Workspace): Promise<ProjectAnswer> {
  const project = (await workspace.state()).projects.find((p) => p.id === id);
  if (!project) return { status: 404, body: { error: 'No such project' } };
  const asked = url.searchParams.get('folder');
  const folder = asked ? folderOf(project, asked) : defaultFolder(project);
  if (asked && !folder) return { status: 404, body: { error: 'That folder is not in this project.' } };
  return { status: 200, body: { ...(await projectChanges(folder)), folderId: folder?.id ?? null } };
}
