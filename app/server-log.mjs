// The packaged app's server log, `server.log` in Electron's log folder for Kestrel:
// ~/Library/Logs/Kestrel on macOS, %APPDATA%\Kestrel\logs on Windows, ~/.config/Kestrel/logs on
// Linux. A checkout prints the server's
// output in the terminal; an installed app has no terminal, so failures the server only logs (a
// title that could not be generated, an agent that would not start) were invisible. One earlier
// file is kept (server.log.1) once this one passes MAX_BYTES at launch. No Electron import: tested.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_BYTES = 2 * 1024 * 1024;

/** Opens the log in `dir` and answers with a function that appends to it. Never throws. */
export function openServerLog(dir, { maxBytes = MAX_BYTES, now = () => new Date() } = {}) {
  const file = join(dir, 'server.log');
  try {
    mkdirSync(dir, { recursive: true });
    if (sizeOf(file) > maxBytes) renameSync(file, `${file}.1`);
    appendFileSync(file, `\n---- Kestrel started ${now().toISOString()} ----\n`);
  } catch {
    return () => undefined; // a log that cannot be written is not worth stopping the app for
  }
  return (chunk) => {
    try {
      appendFileSync(file, chunk);
    } catch {
      // as above
    }
  };
}

function sizeOf(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}
