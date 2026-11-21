// Stop one command, or one piece of background work, on the user's word (Commands pane, the strip):
// design doc, "Stop ends the command itself". Kestrel asks the agent first, through its own control
// channel, never the model: Claude's `stop_task`. When the agent cannot say it stopped it (no answer,
// or it does not know the task) Kestrel ends the command's processes itself, found by the output
// file the command writes to (kill-task.ts). When it had already ended, the row says so at once and
// the user is told. Every other failure is refused with the agent's reason.
import { BackgroundStopFailed, type AgentHandle } from '../agents/types.ts';
import { ENDED_TEXT } from '../shared/commands.ts';
import { Refused } from '../workspace.ts';
import type { BackgroundWork } from './background.ts';
import type { Commands } from './commands.ts';
import { killTaskProcesses, type ProcessSystem } from './kill-task.ts';

export interface StopTarget {
  sessionId: string;
  taskId: string;
  handle: AgentHandle | null | undefined;
  /** The agent's name, for reasons ("Claude"). */
  agentName: string;
}

export class WorkStopper {
  constructor(
    private readonly background: BackgroundWork,
    private readonly commands: Commands,
    private readonly processes: ProcessSystem,
  ) {}

  /** Stop the command `commandId`: refused, with the reason, when it is not running or has no task to stop. */
  async stopCommand(target: Omit<StopTarget, 'taskId'>, commandId: string): Promise<void> {
    const command = this.commands.list(target.sessionId).find((c) => c.id === commandId);
    if (!command) throw new Refused('That command is not listed for this session any more.');
    if (command.status !== 'running') throw new Refused('That command has already ended.');
    if (command.taskId && this.commands.stopSample(target.sessionId, commandId)) return this.stop({ ...target, taskId: command.taskId });
    if (!command.taskId) throw new Refused(command.noStop ?? 'This command cannot be stopped on its own.');
    await this.stop({ ...target, taskId: command.taskId });
  }

  /** Stop one task, listed by the agent or known from a running command's output file. */
  async stop(target: StopTarget): Promise<void> {
    const { sessionId, taskId } = target;
    const known = this.background.has(sessionId, taskId) || this.commands.runningTask(sessionId, taskId) !== undefined;
    if (!known) throw new Refused('That background work is no longer running.');
    if (this.background.isSample(sessionId)) return this.background.drop(sessionId, taskId);
    const file = this.commands.outputFileOf(sessionId, taskId);
    if (!target.handle?.stopBackgroundTask) {
      if (file) return this.endItself(target, file, `${target.agentName} cannot stop background work itself.`);
      throw new Refused(`${target.agentName} cannot stop background work from Kestrel.`);
    }
    try {
      await target.handle.stopBackgroundTask(taskId);
    } catch (error) {
      await this.failed(target, file, error);
    }
  }

  private async failed(target: StopTarget, file: string | undefined, error: unknown): Promise<void> {
    const failure = error instanceof BackgroundStopFailed ? error : new BackgroundStopFailed(error instanceof Error ? error.message : String(error), 'refused');
    if (failure.why === 'ended') {
      this.ended(target, failure.endedAs);
      throw new Refused(`It had already ended (${ENDED_TEXT[failure.endedAs]}), so there was nothing left to stop.`);
    }
    if (failure.why === 'refused') throw new Refused(`It could not be stopped: ${failure.message}`);
    const why = failure.why === 'unknown' ? `${target.agentName} no longer knows this command (an earlier run of its process started it).` : `${target.agentName} did not confirm stopping it.`;
    if (file) return this.endItself(target, file, why);
    throw new Refused(`${why} Kestrel cannot find the command's process to end it itself, so it may still be running.`);
  }

  /** End the command's processes directly. Nothing left running from it: the row says it ended, and the user is told. */
  private async endItself(target: StopTarget, file: string, why: string): Promise<void> {
    const result = await killTaskProcesses(file, this.processes);
    this.ended(target, 'stopped');
    if (result.ended.length === 0) throw new Refused(`${why} Nothing is running from it any more, so it had already ended.`);
  }

  private ended(target: StopTarget, status: 'completed' | 'failed' | 'stopped'): void {
    this.commands.taskEnded(target.sessionId, target.taskId, status);
    this.background.drop(target.sessionId, target.taskId);
  }
}
