// Opens the interactive screen for one command, only where it can work (`canUseWorkerInk`); null keeps the plain
// transcript. Ink and React are loaded here and nowhere else, so a pipe, a dumb terminal, NO_COLOR and a screen reader
// never load them.
import { STOPPED_EXIT } from '../join-client.ts';
import { canUseWorkerInk } from './eligibility.ts';
import { WorkerSession, type WorkerSessionOptions } from './session.ts';

export interface OpenOptions extends WorkerSessionOptions {
  /** Said when Ctrl+C stops the command, after the screen has let go of the terminal. */
  stoppedText: string;
}

/**
 * Ctrl+C with no join to withdraw: the screen lets go first, then the command stops as it did before the screen, with
 * exit code 130. While a program was running (no question waiting), the process group gets the SIGINT a plain
 * terminal would have sent it, so npm, ssh or a tool stops with it.
 */
async function stopHere(session: WorkerSession, text: string, programRunning: boolean): Promise<never> {
  await session.close();
  process.stderr.write(`${text}\n`);
  if (programRunning) {
    process.on('SIGINT', () => undefined);
    try {
      process.kill(0, 'SIGINT');
    } catch {
      // No process group to signal (not a job of a shell): the command still stops.
    }
  }
  process.exit(STOPPED_EXIT);
}

/** Runs a command on its screen; an unexpected error lets go of the terminal first, so its report reads plainly. */
export async function onScreen<T>(screen: WorkerSession | null, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    await screen?.close();
    throw error;
  }
}

export async function openWorkerSession(options: OpenOptions, eligible: boolean = canUseWorkerInk()): Promise<WorkerSession | null> {
  if (!eligible) return null;
  const { openWorkerTerminal } = await import('./terminal.tsx');
  const { stoppedText, ...rest } = options;
  const session: WorkerSession = new WorkerSession(rest, (programRunning) => void stopHere(session, stoppedText, programRunning));
  session.attach(openWorkerTerminal(session.frame(), { onCancel: () => session.cancel() }));
  return session;
}
