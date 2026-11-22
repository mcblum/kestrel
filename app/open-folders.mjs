// Folders handed to Kestrel by the system. On macOS: dropped on the Dock icon or opened with
// `open -a Kestrel.app <folder>` (an open-file event). On Windows and Linux: named on the command
// line, which is how a folder dropped on the shortcut or "Open with" arrives (`foldersInArgs`), at
// launch or handed over by a second launch. They can arrive before the window (or the page in it) exists, so they wait in a queue
// that the page empties when it is ready (preload's onOpenFolders). Kept free of Electron for tests.
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

const isDirectory = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** The paths that are folders, each once. Files (and anything that is not there) are dropped quietly. */
export function foldersOnly(paths, isDir = isDirectory) {
  const seen = new Set();
  return paths.filter((path) => {
    if (typeof path !== 'string' || path === '' || seen.has(path) || !isDir(path)) return false;
    seen.add(path);
    return true;
  });
}

/**
 * The folders named on a command line: everything after the program itself that is not an option,
 * taken from `cwd` when it is not a whole path. Only asked of an installed app: from a checkout the
 * arguments are Electron's own (`electron .`).
 */
export function foldersInArgs(argv, cwd, isDir = isDirectory) {
  const named = argv.slice(1).filter((arg) => typeof arg === 'string' && arg !== '' && !arg.startsWith('-'));
  return foldersOnly(named.map((arg) => resolve(cwd, arg)), isDir);
}

/** Folders waiting for the page: `add` appends (no repeats), `take` hands them all over and empties it. */
export function createFolderQueue() {
  let waiting = [];
  return {
    add(paths) {
      waiting = [...waiting, ...paths.filter((p) => !waiting.includes(p))];
    },
    take() {
      const taken = waiting;
      waiting = [];
      return taken;
    },
    get size() {
      return waiting.length;
    },
  };
}
