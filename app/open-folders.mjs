// Folders handed to Kestrel by macOS: dropped on the Dock icon or opened with `open -a Kestrel.app
// <folder>`. They can arrive before the window (or the page in it) exists, so they wait in a queue
// that the page empties when it is ready (preload's onOpenFolders). Kept free of Electron for tests.
import { statSync } from 'node:fs';

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
