// The native folder chooser, reopening where the last folder was picked from (the parent of the
// last chosen folder), across restarts. Every "Choose folder…" in the app goes through here.
// Kept free of Electron so it can be tested: main.mjs passes in the dialog and the state file.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

const isDirectory = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** Where the chooser opens: the remembered folder if it is still there, otherwise home. */
export function startDirectory(remembered, { exists = isDirectory, home = homedir() } = {}) {
  return typeof remembered === 'string' && remembered !== '' && exists(remembered) ? remembered : home;
}

/** The folder to remember after `chosen` was picked: the one it is in. */
export const rememberFor = (chosen) => dirname(chosen);

/** The remembered folder in the state file, or null when there is none (or it cannot be read). */
export function readRemembered(file) {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    return typeof saved?.lastParent === 'string' ? saved.lastParent : null;
  } catch {
    return null;
  }
}

function writeRemembered(file, lastParent) {
  try {
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ lastParent }));
  } catch {
    // Not being able to remember where you were is not worth interrupting anyone for.
  }
}

/**
 * A folder chooser. `showOpenDialog(options)` is Electron's dialog (bound to the window by the
 * caller); `file` is the JSON file the last parent folder is kept in. `pick()` answers with the
 * chosen folder or null.
 */
export function createFolderChooser({ file, showOpenDialog, exists = isDirectory, home = homedir() }) {
  return async function pick(options = {}) {
    const defaultPath = startDirectory(readRemembered(file), { exists, home });
    const result = await showOpenDialog({ ...options, properties: ['openDirectory', 'createDirectory'], defaultPath });
    const chosen = result.canceled ? null : (result.filePaths[0] ?? null);
    if (chosen) writeRemembered(file, rememberFor(chosen));
    return chosen;
  };
}
