// How a Kestrel server process ends: the entries (index.ts for the app, node.ts for a worker node) call this
// once the server is up. A signal, or for the app its shell closing the pipe it started the server over, runs the
// server's own timed shutdown once and then exits; the whole thing has a deadline, so a quit is never held up by
// one agent or one connection that will not let go (shared/shutdown.ts).
import { SHUTDOWN_DEADLINE_MS } from './shared/shutdown.ts';

export interface Stoppable {
  close(): Promise<unknown>;
}

export interface StopOptions {
  /** The shell that started this process over a pipe stops it by closing that pipe, even if it crashes. */
  exitOnStdinClose?: boolean;
}

/** Stops `server` on SIGINT and SIGTERM (and stdin closing, if asked). Stopping is asked for twice by the shell; it runs once. */
export function stopOnSignals(server: Stoppable, options: StopOptions = {}): () => Promise<void> {
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(0), SHUTDOWN_DEADLINE_MS).unref();
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  if (options.exitOnStdinClose) {
    process.stdin.resume();
    process.stdin.on('end', shutdown);
  }
  process.on('SIGTERM', shutdown);
  return shutdown;
}
