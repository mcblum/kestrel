// Stopping one piece of Claude's background work through the control protocol's `stop_task`
// (`Query.stopTask`). What the CLI answers when it cannot (SDK 0.3.322, read from the bundled CLI):
// "No task found with ID: <id>…" for a task this process does not know, "Task <id> is not running
// (status: <status>)" for one that already ended, and other refusals (owned by another agent, an
// unsupported kind). Live, while the agent was quiet on background work, the CLI did not answer at
// all (docs/spike-results.md, 2026-11-17). Each case becomes a `BackgroundStopFailed` saying which,
// so the runtime can end the process itself or show the row as ended.
import { BackgroundStopFailed } from '../types.ts';
import { TASK_OUTPUT_TIMEOUT_MS, withinTime } from './task-output.ts';

/** How long Kestrel waits for the CLI to confirm a stop before ending the process itself. */
export const STOP_TASK_TIMEOUT_MS = TASK_OUTPUT_TIMEOUT_MS;

export const NO_ANSWER = `Claude did not answer within ${STOP_TASK_TIMEOUT_MS / 1000} seconds.`;
export const NO_RUN = 'The agent is no longer running, so its background work has already ended.';

/** The CLI's task statuses, as Kestrel's command statuses. */
const ENDED_AS: Readonly<Record<string, 'completed' | 'failed' | 'stopped'>> = { completed: 'completed', failed: 'failed', killed: 'stopped', stopped: 'stopped' };

/** What a failed `stopTask` means. Pure. */
export function stopFailure(error: unknown): BackgroundStopFailed {
  if (error instanceof BackgroundStopFailed) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (message === NO_ANSWER) return new BackgroundStopFailed(message, 'no-answer');
  const notRunning = /is not running \(status: (\w+)\)/.exec(message);
  if (notRunning) return new BackgroundStopFailed(message, 'ended', ENDED_AS[notRunning[1]!] ?? 'stopped');
  if (/No task found with ID/.test(message)) return new BackgroundStopFailed(message, 'unknown');
  return new BackgroundStopFailed(message, 'refused');
}

/** Ask the CLI to stop `taskId`; rejects with a `BackgroundStopFailed`. `query` is null once the run is over. */
export async function stopClaudeTask(query: { stopTask(taskId: string): Promise<void> } | null | undefined, taskId: string): Promise<void> {
  if (!query) throw new BackgroundStopFailed(NO_RUN, 'ended');
  try {
    await withinTime(query.stopTask(taskId), STOP_TASK_TIMEOUT_MS, NO_ANSWER);
  } catch (error) {
    throw stopFailure(error);
  }
}
