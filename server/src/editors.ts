// Which of the common editors are installed, for a changed file's "Open in …" items. This file is
// the list and the Mac's way of finding and opening them; openers.ts has Windows and Linux. Detection
// is a pure function over a lookup (does this app exist?), so tests pass a fake one; `installedApp`
// is the real lookup: the app bundle in /Applications or ~/Applications.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_EDITOR_ID, type Editor, type FolderApp } from './shared/file-menu.ts';

/** An editor and the name `open -a` knows its app by; the default app has none. */
export interface EditorApp extends Editor {
  app: string | null;
  /** Off a Mac: the program that starts it (openers.ts). */
  command?: string;
}

/** In the order the menu lists them. */
export const KNOWN_EDITORS: readonly EditorApp[] = [
  { id: 'vscode', label: 'VS Code', app: 'Visual Studio Code' },
  { id: 'cursor', label: 'Cursor', app: 'Cursor' },
  { id: 'zed', label: 'Zed', app: 'Zed' },
  { id: 'sublime', label: 'Sublime Text', app: 'Sublime Text' },
  { id: 'xcode', label: 'Xcode', app: 'Xcode' },
];

const DEFAULT_APP: EditorApp = { id: DEFAULT_EDITOR_ID, label: 'Default app', app: null };

/** The installed editors, then the system's default app, which is always there. */
export function detectEditors(hasApp: (app: string) => boolean): EditorApp[] {
  return [...KNOWN_EDITORS.filter((e) => e.app !== null && hasApp(e.app)), DEFAULT_APP];
}

/** Whether `<app>.app` is in /Applications or the user's own Applications folder. */
export function installedApp(app: string, home = homedir()): boolean {
  return [join('/Applications', `${app}.app`), join(home, 'Applications', `${app}.app`)].some((p) => existsSync(p));
}

/** The editor and the command arguments that open `file` in it (`open -a <App> <file>`, or `open <file>`). */
export function openArgs(editor: EditorApp, file: string): string[] {
  return editor.app ? ['-a', editor.app, file] : [file];
}

// ---- apps that open a folder ("Open in" on the Changes and Files panes) -------------------------

/** A folder app and the name `open -a` knows it by; Finder has none (`open <folder>` is Finder). */
export interface FolderAppEntry extends FolderApp {
  app: string | null;
  /** Off a Mac: the program that starts it (openers.ts). */
  command?: string;
  /** Part of the system: there without looking. */
  builtIn?: boolean;
  /** The app whose icon it shows, when `app` does not say (Finder is opened with no app name). */
  iconApp?: string;
}

/** In the order the menu lists them: the editors, Finder, then terminals. */
export const KNOWN_FOLDER_APPS: readonly FolderAppEntry[] = [
  ...KNOWN_EDITORS.map((e) => ({ id: e.id, label: e.label, app: e.app, kind: 'editor' as const })),
  { id: 'finder', label: 'Finder', app: null, kind: 'finder', builtIn: true, iconApp: 'Finder' },
  { id: 'terminal', label: 'Terminal', app: 'Terminal', kind: 'terminal', builtIn: true },
  { id: 'iterm', label: 'iTerm', app: 'iTerm', kind: 'terminal' },
  { id: 'ghostty', label: 'Ghostty', app: 'Ghostty', kind: 'terminal' },
  { id: 'warp', label: 'Warp', app: 'Warp', kind: 'terminal' },
];

/** The apps on this Mac that can open a folder: what is installed, plus what macOS always has. */
export function detectFolderApps(hasApp: (app: string) => boolean): FolderAppEntry[] {
  return KNOWN_FOLDER_APPS.filter((a) => a.builtIn === true || (a.app !== null && hasApp(a.app)));
}

/** The `open` arguments that open `folder` in the app (`open -a <App> <folder>`, or `open <folder>` for Finder). */
export function openFolderArgs(app: FolderAppEntry, folder: string): string[] {
  return app.app ? ['-a', app.app, folder] : [folder];
}
