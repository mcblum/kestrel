// The right-click menu of a changed file in a session's Changes panel, as data: show its diff, open
// it in each editor the user has, show it in Finder, copy its path. Shared with the UI, which has
// no test runner; the server's file-open-api.ts does the opening and showing.
import type { MenuAction, MenuItem } from './menu.ts';

/** An app that can open a file, as the server detected it (editors.ts). `default` is the system's choice. */
export interface Editor {
  id: string;
  label: string;
}

/** The id of the system's own choice of app for a file. */
export const DEFAULT_EDITOR_ID = 'default';

/** What the server can do with files on this computer (GET /api/editors). */
export interface FileOpeners {
  editors: readonly Editor[];
  /** Whether it can show a file in the file manager. */
  reveal: boolean;
  /** What that file manager is called here (shared/platform.ts); "Finder" when the server does not say. */
  fileManager?: string;
}

export interface ChangedFileTarget {
  /** From the session's working folder, with forward slashes. */
  path: string;
  status: 'M' | 'A' | 'D';
}

export interface FileMenuContext extends FileOpeners {
  /** The session's working folder on disk; null when it has none (then there is no absolute path). */
  folder: string | null;
  /** The file's diff is the one on screen: "Show diff" would do nothing. */
  shown: boolean;
}

/** What a picked item of this menu asks for, beyond the copies (those carry a `copy` action). */
export type FilePick = { kind: 'show-diff' } | { kind: 'open'; editorId: string } | { kind: 'reveal'; path: string } | null;

const OPEN_PREFIX = 'open:';

/** `folder/path`, with one slash between them. */
export function absolutePath(folder: string, path: string): string {
  return `${folder.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** The folder a file is in, from the working folder ('' for the working folder itself). */
export function parentOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

const copy = (id: string, label: string, text: string, what: string): MenuItem => ({ id, label, action: { type: 'copy', text, what } satisfies MenuAction });

function openItems(editors: readonly Editor[]): MenuItem[] {
  return editors.map((e) => ({ id: `${OPEN_PREFIX}${e.id}`, label: e.id === DEFAULT_EDITOR_ID ? 'Open with default app' : `Open in ${e.label}` }));
}

/** First item of a section gets the line above it, unless it starts the menu. */
function sections(...groups: MenuItem[][]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const group of groups.filter((g) => g.length > 0)) out.push(...group.map((it, i) => (i === 0 && out.length > 0 ? { ...it, separatorBefore: true } : it)));
  return out;
}

/**
 * The menu for one changed file. A deleted file has nothing to open: it gets its folder in Finder
 * and the copies. Opening and showing are only offered where the server said it can.
 */
export function changedFileMenu(file: ChangedFileTarget, ctx: FileMenuContext): MenuItem[] {
  const deleted = file.status === 'D';
  const diff: MenuItem[] = ctx.shown ? [] : [{ id: 'show-diff', label: 'Show diff' }];
  const open = deleted ? [] : openItems(ctx.editors);
  const manager = ctx.fileManager ?? 'Finder';
  const reveal: MenuItem[] = !ctx.reveal ? [] : deleted ? [{ id: 'reveal-folder', label: `Show folder in ${manager}` }] : [{ id: 'reveal', label: `Show in ${manager}` }];
  const copies = [...(ctx.folder ? [copy('copy-path', 'Copy path', absolutePath(ctx.folder, file.path), 'path')] : []), copy('copy-relative-path', 'Copy relative path', file.path, 'relative path')];
  return sections(diff, [...open, ...reveal], copies);
}

/** What a picked item asks for; null for a copy (it carries its own action) or an unknown id. */
export function filePick(item: Pick<MenuItem, 'id'>, file: ChangedFileTarget): FilePick {
  if (item.id === 'show-diff') return { kind: 'show-diff' };
  if (item.id === 'reveal') return { kind: 'reveal', path: file.path };
  if (item.id === 'reveal-folder') return { kind: 'reveal', path: parentOf(file.path) };
  if (item.id.startsWith(OPEN_PREFIX)) return { kind: 'open', editorId: item.id.slice(OPEN_PREFIX.length) };
  return null;
}

// ---- "Open in" for a whole folder (the Changes and Files panes) --------------------------------

/** An app that can open a folder where it is, as the server found it (editors.ts, `detectFolderApps`). */
export interface FolderApp {
  id: string;
  label: string;
  /** What it is, so the menu can keep editors, Finder and terminals apart. */
  kind: 'editor' | 'finder' | 'terminal';
  /** The app's own icon, as a small image (a data URL); absent when Kestrel could not read one. */
  icon?: string;
}

/** The app "Open in" uses when the user has not chosen one, when it is installed (Matt, 2026-11-18). */
export const PREFERRED_FOLDER_APP = 'vscode';

/** What the user chose in Settings → Workflow. `defaultApp` null: Kestrel's own choice. */
export interface OpenInPrefs {
  defaultApp: string | null;
}

/** Stored or sent prefs made safe: an app id, or nothing chosen. */
export function sanitizeOpenInPrefs(value: unknown): OpenInPrefs {
  const chosen = (typeof value === 'object' && value !== null ? (value as Record<string, unknown>).defaultApp : null);
  return { defaultApp: typeof chosen === 'string' && /^[a-z0-9-]{1,40}$/.test(chosen) ? chosen : null };
}

/**
 * The app the "Open in" button opens with one click: the one the user chose, when it is still
 * installed; else VS Code when it is installed; else the first editor found; else Finder; else
 * whatever there is. Null only when nothing can open a folder.
 */
export function defaultFolderApp<A extends Pick<FolderApp, 'id' | 'kind'>>(apps: readonly A[], chosen: string | null): A | null {
  return (
    apps.find((a) => a.id === chosen) ??
    apps.find((a) => a.id === PREFERRED_FOLDER_APP) ??
    apps.find((a) => a.kind === 'editor') ??
    apps.find((a) => a.kind === 'finder') ??
    apps[0] ??
    null
  );
}

/**
 * The "Open in" menu of a pane: each app that can open the code where it is now (a session's
 * worktree, a project's folder), editors first, then Finder, then terminals. `scope` is the pane's
 * scope key; `defaultId` marks the app the button opens with one click. With no app to offer it
 * says why, rather than opening an empty menu.
 */
export function openInMenu(apps: readonly FolderApp[], scope: string, defaultId: string | null = null): MenuItem[] {
  if (apps.length === 0) return [{ id: 'open-in-none', label: 'Nothing here can open a folder', disabled: true, hint: 'Opening needs Kestrel to run on a Mac' }];
  return apps.map((app, i) => ({
    id: `open-in:${app.id}`,
    label: app.label,
    ...(app.icon ? { icon: app.icon } : {}),
    // The one the button itself opens with.
    ...(app.id === defaultId ? { value: 'Default' } : {}),
    action: { type: 'open-folder', scope, appId: app.id } as MenuAction,
    ...(i > 0 && apps[i - 1]!.kind !== app.kind ? { separatorBefore: true } : {}),
  }));
}
