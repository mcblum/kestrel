// Which files a tool call edits, as paths inside the session's working folder: the same form a
// ChangedFile's path has, so the conversation can open the Changes pane at that file. A path
// outside the folder is left out (it is not in the session's changes). Pure.
import { isAbsolute, relative, resolve } from 'node:path';

export function pathsInside(cwd: string, paths: readonly string[]): string[] {
  const inside = paths
    .filter((p) => p !== '')
    .map((p) => relative(cwd, resolve(cwd, p)))
    .filter((p) => p !== '' && !p.startsWith('..') && !isAbsolute(p));
  return [...new Set(inside)];
}
