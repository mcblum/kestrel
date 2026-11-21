// Path checks for the PreToolUse hook. Pure apart from reading the file system to resolve
// symlinks. Bash cannot be checked this way; it stays behind approval prompts.
//
// A read-only session is confined: it may read only its own folder and the folders it was given.
// An editing session is not confined: where it may write follows its permission mode. The hook
// only notes when a file tool reaches outside the session's folder, so that the modes that accept
// edits by themselves ask for those (see index.ts).
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';

export interface Confinement {
  /** The session's working directory (worktree, plain folder or scratch). */
  directory: string;
  readOnly: boolean;
  /** Extra folders a read-only session may read. */
  readable: readonly string[];
}

const WRITE_TOOLS: Record<string, string> = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };
const READ_TOOLS: Record<string, string> = { Read: 'file_path', Grep: 'path', Glob: 'path' };

/** Absolute, with symlinks resolved as far as the path exists (a new file resolves through its folder). */
export function resolveReal(path: string, cwd: string): string {
  let current = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const tail: string[] = [];
  while (!existsSync(current) && dirname(current) !== current) {
    tail.unshift(basename(current));
    current = dirname(current);
  }
  const real = existsSync(current) ? realpathSync(current) : current;
  return tail.length ? resolve(real, ...tail) : real;
}

const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** The static folder part of a glob pattern, e.g. `/a/b/*.ts` -> `/a/b`. */
function globRoot(pattern: string): string {
  const cut = pattern.search(/[*?[{]/);
  const head = cut === -1 ? pattern : pattern.slice(0, cut);
  return cut === -1 ? head : head.slice(0, head.lastIndexOf('/') + 1) || '/';
}

/** The file a file-writing tool call targets, resolved, when it lies outside `directory`; else null. */
export function writeOutside(tool: string, input: Record<string, unknown>, directory: string): string | null {
  const key = WRITE_TOOLS[tool];
  const value = key ? input[key] : undefined;
  if (typeof value !== 'string') return null;
  const root = resolveReal(directory, directory);
  const target = resolveReal(value, root);
  return inside(target, root) ? null : target;
}

/** A reason to refuse the call, or null. Only a read-only session is confined. */
export function confinementDenial(tool: string, input: Record<string, unknown>, c: Confinement): string | null {
  if (!c.readOnly) return null;
  const key = READ_TOOLS[tool];
  if (!key) return null;
  const root = resolveReal(c.directory, c.directory);
  const allowed = [root, ...c.readable.map((d) => resolveReal(d, root))];
  const targets: string[] = [];
  if (typeof input[key] === 'string') targets.push(input[key] as string);
  if (tool === 'Glob' && typeof input.pattern === 'string' && isAbsolute(input.pattern)) targets.push(globRoot(input.pattern));
  for (const t of targets) {
    if (!allowed.some((a) => inside(resolveReal(t, root), a))) return `Kestrel: this session is read-only and can only read the registered projects. ${t} is outside them.`;
  }
  return null;
}
