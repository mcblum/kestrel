// Reading a session's working folder for the Files tab: one directory at a time, and small text
// files. Everything is held inside the folder: a path that leaves it, by `..` or through a
// symlink, is refused.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export interface FileEntry {
  name: string;
  /** Path from the folder's root, with forward slashes. */
  path: string;
  dir: boolean;
}

export type FileContent = { kind: 'text'; text: string; truncated: boolean } | { kind: 'binary' } | { kind: 'too-large'; bytes: number };

export class OutsideFolder extends Error {}

const MAX_ENTRIES = 1000;
const MAX_TEXT_BYTES = 256 * 1024;
const HARD_LIMIT_BYTES = 5 * 1024 * 1024;
const HIDDEN = new Set(['.git', '.DS_Store']);

/** The real path of `relative` under `root`, or a refusal if it is not inside `root`. */
export function resolveInside(root: string, relative: string): string {
  const base = realpathSync(root);
  const target = resolve(base, relative || '.');
  if (!existsSync(target)) throw new OutsideFolder('No such file or folder.');
  const real = realpathSync(target);
  if (real !== base && !real.startsWith(base.endsWith(sep) ? base : base + sep)) throw new OutsideFolder('That path is outside this session’s folder.');
  return real;
}

/** The entries of one directory: folders first, then files, each by name. */
export function listDirectory(root: string, relative: string): FileEntry[] {
  const dir = resolveInside(root, relative);
  const prefix = relative.replace(/^\/+|\/+$/g, '');
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => !HIDDEN.has(e.name))
    .map((e) => {
      let isDir = e.isDirectory();
      // A symlink is shown as what it points at, when that is still inside the folder.
      if (e.isSymbolicLink()) {
        try {
          isDir = statSync(resolveInside(root, join(prefix, e.name))).isDirectory();
        } catch {
          isDir = false;
        }
      }
      return { name: e.name, path: prefix ? `${prefix}/${e.name}` : e.name, dir: isDir };
    })
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
    .slice(0, MAX_ENTRIES);
}

/** A file's text, cut at a size the page can show. Binary and very large files are only described. */
export function readFileContent(root: string, relative: string): FileContent {
  const file = resolveInside(root, relative);
  const stat = statSync(file);
  if (!stat.isFile()) throw new OutsideFolder('That is not a file.');
  if (stat.size > HARD_LIMIT_BYTES) return { kind: 'too-large', bytes: stat.size };
  const bytes = readFileSync(file);
  if (bytes.subarray(0, 8000).includes(0)) return { kind: 'binary' };
  return { kind: 'text', text: bytes.subarray(0, MAX_TEXT_BYTES).toString('utf8'), truncated: bytes.length > MAX_TEXT_BYTES };
}
