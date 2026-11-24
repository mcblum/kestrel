// A Markdown or PDF file the user opens to read in a tab of a session (Matt, 2026-11-24: "if the link is
// in the chat, it should just open no matter what"). Opening a file to read, because the person clicked
// a link in the conversation, an inline path, a file card or a file in the Files pane, is their own act on
// their own computer, so it may be anywhere on it. Only the window's document routes call this
// (http.ts, with the per-launch token); no Kestrel tool reaches it, and nothing about the file goes to
// the agent. What an agent may put in front of the user (`send_file`) stays confined to the session's
// folders, in display.ts. A phone never reads a file by path (shared/connect-ops.ts, NEVER_REMOTE).
//
// What is still checked: the file exists, is a regular file, is Markdown or PDF by its real name (so a
// link named report.md cannot hand over something else, symlinks followed), and is not too large. Each
// refusal speaks to the person who clicked.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { tooLargeToView, viewableKind, VIEWABLE_TYPE, type FilePlace } from './shared/viewable-files.ts';
import { Refused } from './workspace.ts';

export const NOT_VIEWABLE = 'Kestrel shows Markdown and PDF files here. Open this one in another app.';

/** Where a link points, as a path on this computer: `~/` is the home folder, a relative path is in the session's folder. */
export function linkedPath(given: string, directory: string | null): string {
  const text = given.trim();
  if (!text) throw new Refused('The link does not name a file.');
  if (text === '~' || text.startsWith('~/')) return join(homedir(), text.slice(1));
  if (isAbsolute(text)) return text;
  if (!directory) throw new Refused(`${text} is a path relative to the session’s folder, and this session has none.`);
  return resolve(directory, text);
}

/** The file the user opens to read: its real path and content type, or a refusal with the reason. */
export function fileToRead(given: string, directory: string | null): { path: string; type: string } {
  const kind = viewableKind(given.trim());
  if (!kind) throw new Refused(NOT_VIEWABLE);
  const target = linkedPath(given, directory);
  if (!existsSync(target)) throw new Refused(`There is no file at ${target}. It may have been moved or deleted.`);
  const path = realpathSync(target);
  const stat = statSync(path);
  if (stat.isDirectory()) throw new Refused(`${target} is a folder, not a file.`);
  if (!stat.isFile()) throw new Refused(`${target} is not an ordinary file, so it is not shown here.`);
  // The real file decides, so a link named report.md cannot hand over something else.
  if (viewableKind(path) !== kind) throw new Refused(NOT_VIEWABLE);
  const tooLarge = tooLargeToView(kind, stat.size);
  if (tooLarge) throw new Refused(tooLarge);
  return { path, type: VIEWABLE_TYPE[kind] };
}

const within = (root: string, path: string): boolean => {
  if (!existsSync(root)) return false;
  const base = realpathSync(root);
  return path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);
};

export function placeOf(path: string, sessionId: string, directory: string | null, worktrees: readonly { id: string; title: string; path: string | null }[]): FilePlace {
  if (directory && within(directory, path)) return { path, inSessionFolder: true };
  const other = worktrees.find((w) => w.id !== sessionId && w.path && within(w.path, path));
  return { path, inSessionFolder: false, ...(other ? { otherSession: { id: other.id, title: other.title } } : {}) };
}
