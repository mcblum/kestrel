// The end of what one piece of background work printed, through the control protocol's
// `get_task_output` request. The request is in the SDK's public protocol types
// (SDKControlGetTaskOutputRequest), but this SDK version has no Query method for it, so it is sent
// through the private `request` that `stopTask` itself uses. Everything that depends on that is here.

/** What get_task_output answers (SDKControlGetTaskOutputResponse). */
interface TaskOutputResponse {
  output?: unknown;
  truncated?: unknown;
}

/** The private method of the SDK's Query that sends a control request and resolves with its answer. */
type ControlRequest = (request: { subtype: 'get_task_output'; task_id: string }, options?: { signal?: AbortSignal }) => Promise<TaskOutputResponse | undefined>;

/** How long the CLI gets to answer. Seen live (CLI 2.1.322): it may never answer, and the pane must not wait forever. */
export const TASK_OUTPUT_TIMEOUT_MS = 4000;

/** Whether this query can be asked for task output (the SDK still has the private method). */
export function canReadTaskOutput(query: unknown): boolean {
  return typeof (query as { request?: unknown } | null)?.request === 'function';
}

/** The last (at most) 8 KiB the task printed, raw, and whether that is only the end of it. Rejects with a reason. */
export async function readTaskOutput(query: unknown, taskId: string, timeoutMs = TASK_OUTPUT_TIMEOUT_MS): Promise<{ text: string; truncated: boolean }> {
  if (!canReadTaskOutput(query)) throw new Error('This version of the Claude Agent SDK cannot be asked for a command’s output.');
  const request = (query as { request: ControlRequest }).request.bind(query);
  let answer: TaskOutputResponse | undefined;
  try {
    answer = await request({ subtype: 'get_task_output', task_id: taskId }, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if ((error as Error | null)?.name === 'TimeoutError' || /abort/i.test(String((error as Error | null)?.message ?? error))) throw new Error(`Claude did not say within ${timeoutMs / 1000} seconds.`);
    throw error;
  }
  return { text: typeof answer?.output === 'string' ? answer.output : '', truncated: answer?.truncated === true };
}

/** `work`, or a rejection saying `reason` once `ms` have passed without it settling. */
export function withinTime<T>(work: Promise<T>, ms: number, reason: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(reason)), ms)));
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}
