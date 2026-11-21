// Stopping the server in order, with each step timed so the log says where a slow quit went, and
// a step that fails noted without stopping the ones after it. The clock is injected for tests.

/** How long the whole shutdown may take before the process exits anyway. The shell waits a little longer. */
export const SHUTDOWN_DEADLINE_MS = 3000;

export type Step = readonly [name: string, run: () => Promise<unknown> | unknown];

/** Runs the steps one after another and answers with "agents 12ms, http 3ms, store 1ms". Never throws. */
export async function timedSteps(steps: readonly Step[], now: () => number = Date.now): Promise<string> {
  const told: string[] = [];
  for (const [name, run] of steps) {
    const start = now();
    try {
      await run();
      told.push(`${name} ${now() - start}ms`);
    } catch (error) {
      told.push(`${name} failed after ${now() - start}ms: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return told.join(', ');
}
