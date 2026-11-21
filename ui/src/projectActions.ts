// The project and directory calls behind the Create project page and a project page's directories.
// Each returns the project or an error to show inline, naming the field it concerns when the server
// says. A server older than this window answers 404 for the new routes: then the error says to restart.
import type { BatchOutcome, FolderListing } from '@kestrel/server/folder-batch';
import type { Project } from '@kestrel/server/model';
import { call } from './store.ts';

/** `project` is the project as saved; a rename answers without it. */
export type ProjectResult = { ok: true; project?: Project } | { ok: false; error: string; field?: string };

export const RESTART_TO_USE = 'Restart Kestrel to use this.';
const NOT_FOUND = 404;

function failure(error: unknown): ProjectResult {
  const status = (error as { status?: number }).status;
  if (status === NOT_FOUND) return { ok: false, error: RESTART_TO_USE };
  const field = (error as { field?: string }).field;
  const message = error instanceof Error ? error.message : String(error);
  return field ? { ok: false, error: message, field } : { ok: false, error: message };
}

async function send(path: string, method: string, body?: unknown): Promise<ProjectResult> {
  try {
    const project = await call<Project | undefined>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return project ? { ok: true, project } : { ok: true };
  } catch (error) {
    return failure(error);
  }
}

const base = (id: string) => `/api/projects/${encodeURIComponent(id)}`;

export type FolderCheck = { ok: true; path: string; isGit: boolean } | { ok: false; error: string; oldServer: boolean };

/** Ask the server whether a path can be a project directory, before anything is saved. */
export async function checkFolder(path: string): Promise<FolderCheck> {
  try {
    const found = await call<{ path: string; isGit: boolean }>('/api/projects/check-folder', { method: 'POST', body: JSON.stringify({ path }) });
    return { ok: true, ...found };
  } catch (error) {
    const result = failure(error);
    return { ok: false, error: result.ok ? '' : result.error, oldServer: (error as { status?: number }).status === NOT_FOUND };
  }
}

/** An answer to one of the several-at-once calls, or the error to show. */
export type Answer<T> = { ok: true; value: T } | { ok: false; error: string };

async function ask<T>(path: string, body: unknown): Promise<Answer<T>> {
  try {
    return { ok: true, value: await call<T>(path, { method: 'POST', body: JSON.stringify(body) }) };
  } catch (error) {
    const result = failure(error);
    return { ok: false, error: result.ok ? '' : result.error };
  }
}

/** The folders directly inside `path`, each marked git or plain, registered or not. */
export const listFolder = (path: string) => ask<FolderListing>('/api/projects/list-folder', { path });

/** A project for each folder, in one request; what became of each. */
export const createProjects = async (folders: readonly string[]): Promise<Answer<BatchOutcome[]>> => {
  const answer = await ask<{ results: BatchOutcome[] }>('/api/projects/create-many', { folders });
  return answer.ok ? { ok: true, value: answer.value.results } : answer;
};

export const projectCalls = {
  create: (name: string, folders: readonly string[], defaultFolder?: string) => send('/api/projects/create', 'POST', { name, folders, ...(defaultFolder ? { defaultFolder } : {}) }),
  addFolder: (projectId: string, path: string) => send(`${base(projectId)}/folders`, 'POST', { path }),
  removeFolder: (projectId: string, folderId: string) => send(`${base(projectId)}/folders/${encodeURIComponent(folderId)}`, 'DELETE'),
  setDefaultFolder: (projectId: string, folderId: string) => send(`${base(projectId)}/folders/default`, 'POST', { folderId }),
  reorderFolders: (projectId: string, folders: readonly string[]) => send(`${base(projectId)}/folders/order`, 'POST', { folders }),
  rename: (projectId: string, name: string) => send(base(projectId), 'PATCH', { name }),
};
