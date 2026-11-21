// HTTP routes that open a session's file in an editor or show it in Finder, for the Changes panel's
// right-click menu. The server runs on the user's Mac, so this works from the app and from a plain
// browser alike. Shaped like organize-api.ts: the caller hands over the path parts and a body
// reader, and gets an answer, or null when the path is not one of these.
//
//   GET  /api/editors                      FileOpeners: the installed editors, and whether Finder can be asked
//   POST /api/sessions/:id/open-file       { path, editor }  opens the file; 204
//   POST /api/sessions/:id/reveal-file     { path }          shows the file (or folder) in Finder; 204
//   GET  /api/folder-apps                  { apps, defaultApp, chosen }: the apps that can open a folder where it
//                                          is (each with its icon), the one the button uses, and the user's choice
//   PATCH /api/folder-apps                 { defaultApp: id | null }  the user's choice (Settings → Workflow)
//   POST /api/open-folder                  { scope, app }    opens the scope's folder in that app; 204
//
// Paths are taken from the session's own folder and refused when they lead outside it. Commands go
// through `run` as an argument array, never a shell string.
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { OutsideFolder, resolveInside } from './files.ts';
import { openArgs, openFolderArgs, type EditorApp, type FolderAppEntry } from './editors.ts';
import { defaultFolderApp, type FileOpeners, type FolderApp } from './shared/file-menu.ts';
import type { OpenIn } from './open-in/prefs.ts';

export type FileOpenAnswer = { status: number; body?: unknown };
type ReadBody = () => Promise<Record<string, unknown>>;

/** Runs a command with its arguments; rejects with a reason when it fails. */
export type RunCommand = (command: string, args: readonly string[]) => Promise<void>;

export interface FileOpenDeps {
  /** The session's working folder, or null when it has none. */
  directoryOf(sessionId: string): Promise<string | null>;
  /** The installed editors (editors.ts), detected once. */
  editors(): readonly EditorApp[];
  /** The apps that can open a folder (editors.ts), detected once. */
  folderApps(): readonly FolderAppEntry[];
  /** Each folder app's own icon by id, as a data URL (app-icons.ts), read once. An app with none is left out. */
  folderAppIcons(): Promise<Record<string, string>>;
  /** The user's default "Open in" app (open-in/prefs.ts). */
  openIn: OpenIn;
  /** The folder a pane's scope shows (a session's worktree, a project's folder), or null when it has none. */
  folderOf(scope: string): Promise<string | null>;
  /** Whether this computer has Finder and `open` (a Mac). */
  canOpen: boolean;
  run: RunCommand;
}

const MAX_PATH = 4096;
const MAX_ID = 100;
const OPEN = '/usr/bin/open';

const bad = (error: string): FileOpenAnswer => ({ status: 400, body: { error } });

/** `open` through execFile: no shell, so a path cannot become a command. */
export const runCommand: RunCommand = (command, args) =>
  new Promise((resolve, reject) => execFile(command, [...args], { timeout: 15_000 }, (error, _out, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolve())));

export async function fileOpenRoute(parts: readonly string[], method: string, readBody: ReadBody, deps: FileOpenDeps): Promise<FileOpenAnswer | null> {
  if (parts[1] === 'editors' && parts.length === 2 && method === 'GET') {
    const openers: FileOpeners = deps.canOpen ? { editors: deps.editors().map(({ id, label }) => ({ id, label })), reveal: true } : { editors: [], reveal: false };
    return { status: 200, body: openers };
  }
  if (parts[1] === 'folder-apps' && parts.length === 2 && (method === 'GET' || method === 'PATCH')) {
    if (method === 'PATCH') {
      const wanted = (await readBody()).defaultApp;
      if (wanted !== null && !(typeof wanted === 'string' && deps.folderApps().some((a) => a.id === wanted))) return bad('defaultApp must be an app Kestrel found on this Mac, or null for its own choice');
      await deps.openIn.setDefaultApp(wanted);
    }
    return { status: 200, body: await folderAppsAnswer(deps) };
  }
  if (parts[1] === 'open-folder' && parts.length === 2 && method === 'POST') return openFolder(await readBody(), deps);
  if (parts[1] !== 'sessions' || parts.length !== 4 || method !== 'POST') return null;
  if (parts[3] !== 'open-file' && parts[3] !== 'reveal-file') return null;
  if (!deps.canOpen) return { status: 409, body: { error: 'Opening files needs the Kestrel server to run on a Mac.' } };
  const body = await readBody();
  const relative = body.path;
  if (typeof relative !== 'string' || relative.length > MAX_PATH || relative.includes('\0')) return bad('path must be a path inside the session’s folder');
  const opening = parts[3] === 'open-file';
  if (opening && !relative.trim()) return bad('path is required');
  const editor = opening ? deps.editors().find((e) => e.id === body.editor) : undefined;
  if (opening && !editor) return bad(typeof body.editor === 'string' && body.editor.length <= MAX_ID ? `${body.editor} is not an editor Kestrel found on this Mac.` : 'editor is required');

  let sessionId: string;
  try {
    sessionId = decodeURIComponent(parts[2]!);
  } catch {
    return bad('The session id in the path is not valid.');
  }
  const folder = await deps.directoryOf(sessionId);
  if (!folder || !existsSync(folder)) return { status: 409, body: { error: 'This session has no folder on disk.' } };
  let target: string;
  try {
    target = resolveInside(folder, relative);
  } catch (error) {
    if (error instanceof OutsideFolder) return { status: 404, body: { error: error.message } };
    throw error;
  }
  if (opening && !statSync(target).isFile()) return bad('That is not a file.');
  // Showing in Finder selects the item in its folder; `open -R` never launches it, even an app bundle.
  const args = editor ? openArgs(editor, target) : ['-R', target];
  try {
    await deps.run(OPEN, args);
  } catch (error) {
    return { status: 409, body: { error: `macOS could not ${opening ? 'open' : 'show'} it: ${error instanceof Error ? error.message : String(error)}` } };
  }
  return { status: 204 };
}

/** Open the folder a pane shows in one of the apps found here. The folder comes from the scope, never from the request. */
async function openFolder(body: Record<string, unknown>, deps: FileOpenDeps): Promise<FileOpenAnswer> {
  if (!deps.canOpen) return { status: 409, body: { error: 'Opening a folder needs the Kestrel server to run on a Mac.' } };
  if (typeof body.scope !== 'string' || !body.scope || body.scope.length > MAX_ID * 2) return bad('scope is required');
  const app = deps.folderApps().find((a) => a.id === body.app);
  if (!app) return bad(typeof body.app === 'string' && body.app.length <= MAX_ID ? `${body.app} is not an app Kestrel found on this Mac.` : 'app is required');
  const folder = await deps.folderOf(body.scope);
  if (!folder || !existsSync(folder)) return { status: 409, body: { error: 'There is no folder on disk to open here.' } };
  if (!statSync(folder).isDirectory()) return bad('That is not a folder.');
  try {
    await deps.run(OPEN, openFolderArgs(app, folder));
  } catch (error) {
    return { status: 409, body: { error: `macOS could not open it in ${app.label}: ${error instanceof Error ? error.message : String(error)}` } };
  }
  return { status: 204 };
}

/** What the UI holds about "Open in": the apps with their icons, the one the button opens with, and what the user chose. */
export interface FolderAppsAnswer {
  apps: FolderApp[];
  /** The app the button itself opens with (`defaultFolderApp`); null when nothing can open a folder. */
  defaultApp: string | null;
  /** What the user chose in Settings → Workflow; null: Kestrel's own choice. */
  chosen: string | null;
}

async function folderAppsAnswer(deps: FileOpenDeps): Promise<FolderAppsAnswer> {
  if (!deps.canOpen) return { apps: [], defaultApp: null, chosen: null };
  const [icons, prefs] = await Promise.all([deps.folderAppIcons().catch(() => ({}) as Record<string, string>), deps.openIn.prefs()]);
  const apps: FolderApp[] = deps.folderApps().map(({ id, label, kind }) => ({ id, label, kind, ...(icons[id] ? { icon: icons[id] } : {}) }));
  return { apps, defaultApp: defaultFolderApp(apps, prefs.defaultApp)?.id ?? null, chosen: prefs.defaultApp };
}
