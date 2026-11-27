// Kestrel's own log for a node started by hand (`kestrel-node run` with no systemd running it): what the server
// prints also goes to `~/.kestrel/logs/node.log`, readable by the user only, so `kestrel-node logs` has something to
// read. Under systemd the journal keeps it instead. One earlier file is kept (node.log.1) once this one passes
// MAX_LOG_BYTES at start, as the app's server log does (app/server-log.mjs).
import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const MAX_LOG_BYTES = 2 * 1024 * 1024;

/** Where a node started by hand logs, in its data folder. */
export const nodeLogFile = (dataDir: string): string => join(dataDir, 'logs', 'node.log');

const sizeOf = (file: string): number => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};

/** Opens the log and answers with a function that appends to it, or null when it cannot be written. Never throws. */
export function openNodeLog(file: string, maxBytes = MAX_LOG_BYTES, now: () => Date = () => new Date()): ((chunk: string) => void) | null {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    if (sizeOf(file) > maxBytes) renameSync(file, `${file}.1`);
    appendFileSync(file, `\n---- Kestrel worker node started ${now().toISOString()} ----\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch {
    return null;
  }
  return (chunk) => {
    try {
      appendFileSync(file, chunk);
    } catch {
      // A log that cannot be written is not worth stopping the node for.
    }
  };
}

/** Copies everything the process prints to the log, still printing it as before. */
export function teeOutputTo(append: (chunk: string) => void): void {
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      append(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
      return write(chunk, ...rest);
    }) as typeof stream.write;
  }
}
