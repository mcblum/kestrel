// Background commands a run started, known from the calls themselves rather than from the CLI's
// list of tasks. Seen live on SDK 0.3.322 (2026-11-19): after a background command was stopped and
// "Re-run command" started it again, the resumed CLI process never listed the new task in a
// `background_tasks_changed` before the turn ended, so the run phase counted no work alive, read the
// end of the turn as the end of the run, and the session read as working until the command finished.
// A `Bash` call with `run_in_background` whose result came back is work alive until the CLI says it
// ended (`task_notification`, or `task_updated` with an ending status). Pure apart from its own state.
import type { SdkLike } from './map.ts';

const SHELL_TOOL = 'Bash';
/** `task_updated` statuses that mean the task is over. */
const ENDED = new Set(['completed', 'failed', 'killed']);

type Block = { type?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; is_error?: boolean };

const blocks = (m: SdkLike): Block[] => (Array.isArray(m.message?.content) ? (m.message.content as Block[]) : []);

export class BackgroundCalls {
  /** Backgrounded shell calls not yet answered, by tool use id. */
  private readonly asked = new Set<string>();
  /** Backgrounded shell calls that started work, by tool use id. */
  private readonly alive = new Set<string>();
  /** Which call each task came from (`task_started` names both). */
  private readonly callOf = new Map<string, string>();

  /** How many are alive. */
  get count(): number {
    return this.alive.size;
  }

  /** Read one main-thread SDK message. */
  see(m: SdkLike): void {
    if (m.type === 'assistant') this.called(m);
    else if (m.type === 'user') this.answered(m);
    else if (m.type === 'system' && m.subtype === 'task_started') this.tie(m);
    else if (m.type === 'system' && m.subtype === 'task_notification') this.end(m.task_id, m.tool_use_id);
    else if (m.type === 'system' && m.subtype === 'task_updated' && ENDED.has(m.patch?.status)) this.end(m.task_id, undefined);
  }

  private called(m: SdkLike): void {
    for (const b of blocks(m)) if (b.type === 'tool_use' && b.name === SHELL_TOOL && b.input?.run_in_background === true && b.id) this.asked.add(b.id);
  }

  private answered(m: SdkLike): void {
    for (const b of blocks(m)) {
      if (b.type !== 'tool_result' || !b.tool_use_id || !this.asked.delete(b.tool_use_id)) continue;
      if (b.is_error !== true) this.alive.add(b.tool_use_id);
    }
  }

  private tie(m: SdkLike): void {
    if (typeof m.task_id === 'string' && typeof m.tool_use_id === 'string') this.callOf.set(m.task_id, m.tool_use_id);
  }

  private end(taskId: unknown, toolUseId: unknown): void {
    const call = typeof toolUseId === 'string' ? toolUseId : typeof taskId === 'string' ? this.callOf.get(taskId) : undefined;
    if (call) this.alive.delete(call);
  }
}
