// The routes of one session's page that are not its conversation: the Details sources, the Changes pane's files, a
// document tab, the queue, the Commands pane, the request form and merge, rename, tags, archive, roles, review and fork. One
// function answers them for this computer's window (http.ts) and, in process, for another desktop of the account that
// shows the session (connect/dispatcher.ts, the desk-only operations of shared/connect-ops.ts). So a session there is
// read and acted on by exactly the checks a session here is: the same path confinement, the same refusals.
//
// Shaped like details-api.ts: the caller hands over the path parts and gets an answer, or null when the path is not
// one of these. A file's bytes come back as `{ type, bytes }`; everything else as a JSON body.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { detailsRoute, type DetailsSources } from './details-api.ts';
import { controlsRoute } from './controls-api.ts';
import { IMAGE_TYPES } from './display.ts';
import { fileToRead, placeOf } from './file-to-read.ts';
import { OutsideFolder, listDirectory, readFileContent, resolveInside } from './files.ts';
import { organizeRoute } from './organize-api.ts';
import { createPRRoutes } from './pull-requests/create-api.ts';
import { samplePullRequests } from './pull-requests/fake.ts';
import { mergePRRoute } from './pull-requests/merge-api.ts';
import type { TitleProvider } from './agents/title-providers.ts';
import { Refused } from './refused.ts';
import { BadRequest, decodedSegment, optionalId, str } from './request-fields.ts';
import type { SessionRuntime } from './runtime.ts';
import { noFolderReason } from './scope-folder.ts';
import { AUTOMATIC } from './shared/git-defaults.ts';
import type { Workspace } from './workspace.ts';

/** A local picture a markdown image may point at. */
export const RAW_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export type Body = Record<string, unknown>;
export type RouteAnswer = { status: number; body?: unknown } | { status: 200; type: string; bytes: Buffer };
export type SessionRoute = (parts: readonly string[], method: string, url: URL, read: () => Promise<Body>) => Promise<RouteAnswer | null>;

export interface SessionRouteDeps {
  workspace: Workspace;
  runtime: SessionRuntime | null;
  details: { sources: DetailsSources; sample: boolean };
  /** Who may write a request's generated text (index.ts chooses them once, for titles too). */
  writers?: readonly TitleProvider[];
}

export interface SessionRoutes {
  route: SessionRoute;
  /** A session was deleted through the route: what else goes with it here (its shells). */
  onDeleted(listener: (sessionId: string) => void): () => void;
}

/** One directory, or one file, inside a scope's folder (scope-folder.ts): the Files view, and a changed file's content. */
export async function scopeFiles(runtime: SessionRuntime, key: string, what: 'files' | 'file', url: URL): Promise<RouteAnswer> {
  const directory = await runtime.folderOf(key, url.searchParams.get('folder'));
  if (!directory || !existsSync(directory)) return { status: 404, body: { error: noFolderReason(key) } };
  const path = url.searchParams.get('path') ?? '';
  try {
    return { status: 200, body: what === 'files' ? { root: directory, entries: listDirectory(directory, path), note: await runtime.folderNote(key) } : readFileContent(directory, path) };
  } catch (error) {
    if (error instanceof OutsideFolder) return { status: 400, body: { error: error.message } };
    throw error;
  }
}

/** An image file in the session's folder, for a markdown image that points at a local file. */
async function rawImage(runtime: SessionRuntime, sessionId: string, url: URL): Promise<RouteAnswer> {
  const directory = await runtime.directoryOf(sessionId);
  if (!directory || !existsSync(directory)) return { status: 404, body: { error: 'This session has no folder on disk.' } };
  const path = url.searchParams.get('path') ?? '';
  const type = IMAGE_TYPES[extname(path).slice(1).toLowerCase()];
  if (!type) return { status: 400, body: { error: 'Only png, jpg, gif, webp and svg images are served.' } };
  let file: string;
  try {
    file = resolveInside(directory, path);
  } catch (error) {
    if (error instanceof OutsideFolder) return { status: 404, body: { error: error.message } };
    throw error;
  }
  const stat = statSync(file);
  if (!stat.isFile()) return { status: 404, body: { error: 'That is not a file.' } };
  if (stat.size > RAW_IMAGE_MAX_BYTES) return { status: 413, body: { error: 'That image is larger than 10 MB.' } };
  return { status: 200, type, bytes: readFileSync(file) };
}

/**
 * A Markdown or PDF file the user opened to read in a tab of the session (file-to-read.ts decides which files, and
 * says why not), or where it is, for the tab.
 */
async function document(workspace: Workspace, runtime: SessionRuntime, sessionId: string, what: 'document' | 'document-place', url: URL): Promise<RouteAnswer> {
  try {
    const directory = await runtime.directoryOf(sessionId);
    const file = fileToRead(url.searchParams.get('path') ?? '', directory);
    if (what === 'document') return { status: 200, type: file.type, bytes: readFileSync(file.path) };
    const sessions = (await workspace.state()).sessions;
    return { status: 200, body: placeOf(file.path, sessionId, directory, sessions.map((s) => ({ id: s.id, title: s.title, path: s.worktreePath }))) };
  } catch (error) {
    if (error instanceof Refused) return { status: 404, body: { error: error.message } };
    throw error;
  }
}

/** The routes that need the agent runtime: files, the queue, commands, roles, review and fork. Null when the path is not one. */
async function runtimeRoute(runtime: SessionRuntime, workspace: Workspace, parts: readonly string[], method: string, url: URL, read: () => Promise<Body>): Promise<RouteAnswer | null> {
  const id = parts[2]!;
  const [what, sub, action] = [parts[3], parts[4], parts[5]];
  if (parts.length === 4 && method === 'GET') {
    // The Files view of a session (a bare id is a session's scope key).
    if (what === 'files' || what === 'file') return scopeFiles(runtime, decodedSegment(id), what, url);
    if (what === 'raw') return rawImage(runtime, id, url);
    if (what === 'document' || what === 'document-place') return document(workspace, runtime, id, what, url);
  }
  // A review of the session's work by the Review role's agent (delegation.ts `startReview`): where it stands, and
  // starting one; with who would review it, or why nobody can: whoever wrote the code does not review it.
  if (what === 'review' && parts.length === 4 && method === 'GET') return { status: 200, body: { review: runtime.delegation.reviewOf(id), ...(await runtime.delegation.reviewerFor(id)) } };
  if (what === 'review' && parts.length === 4 && method === 'POST') return { status: 200, body: { review: await runtime.delegation.startReview(id, { comment: (await read()).comment === true }) } };
  // A role's part started by the user from the message box (delegation.ts `startRole`).
  if (what === 'role' && parts.length === 4 && method === 'POST') {
    const body = await read();
    if (body.role !== 'design' && body.role !== 'build') throw new BadRequest('role must be design or build');
    return { status: 200, body: { session: await runtime.delegation.startRole(id, body.role, typeof body.brief === 'string' ? body.brief : '') } };
  }
  if (what === 'fork' && parts.length === 4 && method === 'POST') {
    // `turn`: the message that started the turn to fork from; absent, the end of the conversation.
    const turn = optionalId((await read()).turn, 'turn');
    return { status: 201, body: await runtime.forks.fork(id, turn ?? undefined) };
  }
  if (parts.length === 6 && sub) {
    const item = decodedSegment(sub);
    // Stop one piece of work the agent left running in the background (runtime/background.ts).
    if (method === 'POST' && what === 'background-tasks' && action === 'stop') {
      await runtime.stopBackgroundTask(id, item);
      return { status: 204 };
    }
    // The Commands pane: what one command printed, running one again, and stopping one (runtime/commands.ts).
    if (what === 'commands' && action === 'output' && method === 'GET') return { status: 200, body: await runtime.commandOutput(id, item) };
    if (what === 'commands' && action === 'retry' && method === 'POST') return { status: 200, body: { outcome: await runtime.retryCommand(id, item) } };
    if (what === 'commands' && action === 'stop' && method === 'POST') {
      await runtime.stopCommand(id, item);
      return { status: 204 };
    }
  }
  // The queue of messages written while the agent worked: send it now, or drop one message.
  if (what === 'queue' && parts.length === 5 && method === 'POST' && sub === 'send') {
    await runtime.sendQueued(id);
    return { status: 204 };
  }
  if (what === 'queue' && parts.length === 5 && method === 'DELETE' && sub) {
    await runtime.removeQueued(id, decodedSegment(sub));
    return { status: 204 };
  }
  return null;
}

/** The session-page routes, built once; see the top of this file. */
export function sessionRoutes(deps: SessionRouteDeps): SessionRoutes {
  const { workspace, runtime, details } = deps;
  const deleted = new Set<(sessionId: string) => void>();
  const createPR = createPRRoutes({
    samples: details.sample ? (details.sources.samples ?? samplePullRequests()) : null,
    writers: deps.writers ?? [],
    gitDefaults: async (projectId) => (runtime ? runtime.gitDefaults.of(projectId) : AUTOMATIC),
    onCreated: (sessionId, autopilot) => runtime?.noteFormRequest(sessionId, autopilot),
  });
  /**
   * A session's own archive runs its project's archive script first; a failure stops the archive and says why, with
   * the script's output, and the same request with `skipScript` archives without it. Restoring runs nothing. Refusals
   * (a session still working, one that does not exist) are the workspace's own.
   */
  const archive = async (id: string, body: Body): Promise<RouteAnswer> => {
    const archived = body.archived !== false;
    if (runtime && archived) {
      const failure = await runtime.archiveSession(id, body.skipScript === true);
      if (failure) return { status: 409, body: { error: failure.reason, archiveScript: { output: failure.output } } };
      return { status: 204 };
    }
    await workspace.setArchived('session', id, archived);
    return { status: 204 };
  };
  const route: SessionRoute = async (parts, method, url, read) => {
    if (parts[0] !== 'api' || parts[1] !== 'sessions' || !parts[2]) return null;
    const id = parts[2];
    if (parts.length === 3 && method === 'PATCH') {
      await workspace.renameSession(id, str((await read()).title, 'title', 200));
      return { status: 204 };
    }
    // Archive or restore it: what `/api/archive` does for a session, here or for any device of the account.
    if (parts.length === 4 && parts[3] === 'archive' && method === 'POST') return archive(id, await read());
    if (parts.length === 3 && method === 'DELETE' && runtime) {
      await runtime.deleteSession(id);
      for (const listener of deleted) listener(id); // its shells go with it (not before: a refused delete keeps them)
      return { status: 204 };
    }
    // Tags (organize-api.ts).
    if (parts[3] === 'tags') return organizeRoute(parts, method, read, workspace);
    // The Details sources: git status, pull requests, usage, the repository, a row's change counts (details-api.ts).
    const shown = await detailsRoute(parts, method, url, workspace, runtime ?? undefined, details.sources, details.sample);
    if (shown) return shown;
    // How full the context window is (controls-api.ts).
    if (parts[3] === 'context') return controlsRoute(parts, method, runtime);
    // The New PR form, and merging a request (pull-requests/create-api.ts, merge-api.ts).
    const created = await createPR(parts, method, read, workspace);
    if (created) return created;
    const merged = await mergePRRoute(parts, method, read, workspace, details.sample, details.sources.store);
    if (merged) return merged;
    return runtime ? runtimeRoute(runtime, workspace, parts, method, url, read) : null;
  };
  return {
    route,
    onDeleted(listener) {
      deleted.add(listener);
      return () => deleted.delete(listener);
    },
  };
}
