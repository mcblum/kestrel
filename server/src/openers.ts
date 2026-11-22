// Opening a file or a folder in another app, on each kind of computer (editors.ts has the Mac's
// list of apps; this adds how Windows and Linux find and start theirs). One `Openers` per
// platform: which editors are there, and the program and arguments for each of the three things
// the "Open in" menus do. Every launch is a program with an argument array, never a shell string.
//
//   macOS    `open -a <App> <path>`; `open <path>` for the default app and Finder; `open -R` shows
//            a file in Finder. Apps are found as bundles in /Applications (editors.ts).
//   Linux    an editor is its command on PATH (`code`, `cursor`, `zed`, `subl`); `xdg-open` is the
//            default app and the file manager. There is no one way to select a file in every
//            file manager, so "show" opens the folder the file is in. No terminals are offered:
//            each takes its folder a different way.
//   Windows  an editor is its program in the place its installer puts it; `explorer.exe` is the
//            default app and File Explorer, and `/select,` shows a file in its folder. Explorer
//            exits with 1 even when it worked, so its exit code says nothing (`anyExit`).
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { detectEditors, detectFolderApps, installedApp, KNOWN_EDITORS, openArgs, openFolderArgs, type EditorApp, type FolderAppEntry } from './editors.ts';
import { DEFAULT_EDITOR_ID } from './shared/file-menu.ts';
import { FILE_MANAGER_NAME, type Platform } from './shared/platform.ts';

/** A program, its arguments, and whether its exit code means anything. */
export interface OpenLaunch {
  command: string;
  args: string[];
  anyExit?: boolean;
}

export interface Openers {
  platform: Platform;
  /** The installed editors, then the system's default app. */
  editors: EditorApp[];
  /** The apps that can open a folder: the editors, the file manager and, on a Mac, terminals. */
  folderApps: FolderAppEntry[];
  openFile(editor: EditorApp, file: string): OpenLaunch;
  /** Show a file or folder in the file manager. */
  reveal(target: string): OpenLaunch;
  openFolder(app: FolderAppEntry, folder: string): OpenLaunch;
}

/** What is asked of the computer, so tests can stand in for it. */
export interface OpenerLookup {
  exists(path: string): boolean;
  isFolder(path: string): boolean;
  env: Record<string, string | undefined>;
  home: string;
}

const isFolderOnDisk = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

export const realLookup = (): OpenerLookup => ({ exists: existsSync, isFolder: isFolderOnDisk, env: process.env, home: homedir() });

const MAC_OPEN = '/usr/bin/open';

/** Each editor's command on a Linux PATH, by its id in KNOWN_EDITORS. Xcode is a Mac app. */
const LINUX_COMMANDS: Record<string, readonly string[]> = { vscode: ['code'], cursor: ['cursor'], zed: ['zed', 'zeditor'], sublime: ['subl'] };

/** Where each editor's installer puts its program on Windows, under the folder a variable names. */
const WINDOWS_PROGRAMS: Record<string, readonly { under: string; path: string[] }[]> = {
  vscode: [
    { under: 'LOCALAPPDATA', path: ['Programs', 'Microsoft VS Code', 'Code.exe'] },
    { under: 'ProgramFiles', path: ['Microsoft VS Code', 'Code.exe'] },
  ],
  cursor: [{ under: 'LOCALAPPDATA', path: ['Programs', 'cursor', 'Cursor.exe'] }],
  zed: [{ under: 'LOCALAPPDATA', path: ['Programs', 'Zed', 'Zed.exe'] }],
  sublime: [{ under: 'ProgramFiles', path: ['Sublime Text', 'sublime_text.exe'] }],
};

const onPath = (program: string, look: OpenerLookup): string | null =>
  (look.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, program))
    .find((candidate) => look.exists(candidate)) ?? null;

const defaultApp: EditorApp = { id: DEFAULT_EDITOR_ID, label: 'Default app', app: null };

/** The editors found by `find`, each with the program that starts it, then the default app. */
function editorsWith(find: (id: string) => string | null): EditorApp[] {
  const found = KNOWN_EDITORS.flatMap((editor) => {
    const command = find(editor.id);
    return command ? [{ id: editor.id, label: editor.label, app: null, command }] : [];
  });
  return [...found, defaultApp];
}

/** The editors (not the default app) as folder apps, then the file manager. */
function foldersWith(editors: readonly EditorApp[], platform: Platform): FolderAppEntry[] {
  const label = platform === 'windows' ? FILE_MANAGER_NAME.windows : 'File manager';
  return [...editors.filter((e) => e.command).map((e) => ({ id: e.id, label: e.label, app: null, command: e.command, kind: 'editor' as const })), { id: 'finder', label, app: null, kind: 'finder' as const, builtIn: true }];
}

function macOpeners(look: OpenerLookup): Openers {
  const has = (app: string) => installedApp(app, look.home);
  return {
    platform: 'mac',
    editors: detectEditors(has),
    folderApps: detectFolderApps(has),
    openFile: (editor, file) => ({ command: MAC_OPEN, args: openArgs(editor, file) }),
    // `open -R` selects the item in its folder and never launches it, even an app bundle.
    reveal: (target) => ({ command: MAC_OPEN, args: ['-R', target] }),
    openFolder: (app, folder) => ({ command: MAC_OPEN, args: openFolderArgs(app, folder) }),
  };
}

function linuxOpeners(look: OpenerLookup): Openers {
  const editors = editorsWith((id) => (LINUX_COMMANDS[id] ?? []).map((name) => onPath(name, look)).find((path) => path !== null) ?? null);
  const xdg = (path: string): OpenLaunch => ({ command: 'xdg-open', args: [path] });
  return {
    platform: 'linux',
    editors,
    folderApps: foldersWith(editors, 'linux'),
    openFile: (editor, file) => (editor.command ? { command: editor.command, args: [file] } : xdg(file)),
    reveal: (target) => xdg(look.isFolder(target) ? target : dirname(target)),
    openFolder: (app, folder) => (app.command ? { command: app.command, args: [folder] } : xdg(folder)),
  };
}

function windowsOpeners(look: OpenerLookup): Openers {
  const program = (id: string): string | null =>
    (WINDOWS_PROGRAMS[id] ?? [])
      .flatMap((place) => (look.env[place.under] ? [join(look.env[place.under]!, ...place.path)] : []))
      .find((path) => look.exists(path)) ?? null;
  const editors = editorsWith(program);
  const explorer = (...args: string[]): OpenLaunch => ({ command: 'explorer.exe', args, anyExit: true });
  return {
    platform: 'windows',
    editors,
    folderApps: foldersWith(editors, 'windows'),
    openFile: (editor, file) => (editor.command ? { command: editor.command, args: [file] } : explorer(file)),
    reveal: (target) => explorer(`/select,${target}`),
    openFolder: (app, folder) => (app.command ? { command: app.command, args: [folder] } : explorer(folder)),
  };
}

export function openersFor(platform: Platform, look: OpenerLookup = realLookup()): Openers {
  if (platform === 'mac') return macOpeners(look);
  return platform === 'windows' ? windowsOpeners(look) : linuxOpeners(look);
}
