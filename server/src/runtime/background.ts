// The background work each session's agent left running (shared/background-tasks.ts), kept live and
// never stored, like the helpers and the status line. The agent reports the whole list each time it
// changes; this keeps when each task was first seen and sends the list on the session's live
// channel. Stopping one task is runtime/stop-work.ts. Sample data (KESTREL_FAKE=1) can put a list on a session
// that has no agent behind it, so the strip can be seen; stopping a sample task just drops it.
import type { AgentHandle } from '../agents/types.ts';
import type { LivePatch } from '../model.ts';
import { withFirstSeen, type BackgroundTask, type LiveBackgroundTask } from '../shared/background-tasks.ts';

const NONE: readonly LiveBackgroundTask[] = [];

export class BackgroundWork {
  private readonly lists = new Map<string, readonly LiveBackgroundTask[]>();
  /** Sessions whose list is sample data, not an agent's. */
  private readonly samples = new Set<string>();

  constructor(
    private readonly now: () => number,
    private readonly emit: (sessionId: string, patch: LivePatch) => void,
  ) {}

  /** The session's background work as it now stands. */
  list(sessionId: string): LiveBackgroundTask[] {
    return [...(this.lists.get(sessionId) ?? NONE)];
  }

  /** The agent's new list replaces the last one; tasks already listed keep when they were first seen. */
  replace(sessionId: string, tasks: readonly BackgroundTask[]): void {
    this.samples.delete(sessionId);
    this.set(sessionId, withFirstSeen(this.lists.get(sessionId) ?? NONE, tasks, this.now()));
  }

  /** The agent's process ended or restarted, or the session was stopped: nothing it ran is still running. */
  clear(sessionId: string): void {
    this.samples.delete(sessionId);
    if ((this.lists.get(sessionId) ?? NONE).length > 0) this.set(sessionId, []);
  }

  /** The session is gone. */
  forget(sessionId: string): void {
    this.samples.delete(sessionId);
    this.lists.delete(sessionId);
  }

  /** Whether the agent lists the task `taskId` now. */
  has(sessionId: string, taskId: string): boolean {
    return (this.lists.get(sessionId) ?? NONE).some((t) => t.id === taskId);
  }

  /** Whether the session's list is sample data, with no agent behind it. */
  isSample(sessionId: string): boolean {
    return this.samples.has(sessionId);
  }

  /** Take the task `taskId` off the list: it was stopped or found ended, before the agent says so. */
  drop(sessionId: string, taskId: string): void {
    const listed = this.lists.get(sessionId) ?? NONE;
    if (listed.some((t) => t.id === taskId)) this.set(sessionId, listed.filter((t) => t.id !== taskId));
  }

  /** SAMPLE: a list for a session with no agent behind it, so the strip shows in fake mode. */
  showSample(sessionId: string, tasks: readonly LiveBackgroundTask[]): void {
    this.lists.set(sessionId, [...tasks]);
    this.samples.add(sessionId);
  }

  private set(sessionId: string, tasks: LiveBackgroundTask[]): void {
    if (tasks.length === 0) this.lists.delete(sessionId);
    else this.lists.set(sessionId, tasks);
    this.emit(sessionId, { backgroundTasks: tasks });
  }
}
