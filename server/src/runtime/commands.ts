// Each session's commands (shared/commands.ts). Fed by the agent's events; the list goes out on the
// session's live channel whenever it changes, and is stored with the session (`stored`, `restore`)
// so it is there after a restart, with the end of what each command printed. Output is not pushed: the Commands pane asks for the one it shows (`output`), which for
// Claude's background work asks the agent and for everything else reads what was collected here.
import type { AgentEvent, AgentHandle } from '../agents/types.ts';
import type { LivePatch } from '../model.ts';
import {
  DEFAULT_COMMANDS_KEPT,
  keepRecent,
  allEnded,
  backgroundEnded,
  backgroundListed,
  commandReturned,
  commandStarted,
  plainOutput,
  restoredCommands,
  STORED_OUTPUT_CHARS,
  tail,
  type CommandOutput,
  type CommandStatus,
  type SessionCommand,
  type StoredCommands,
} from '../shared/commands.ts';
import { reasonOf } from '../shared/sourced.ts';
import { isTaskOutputPath, readOutputTail, taskIdOfOutput } from './task-output-file.ts';
import { Refused } from '../workspace.ts';

/** Output kept per command, from its end. */
export const OUTPUT_MAX_CHARS = 64_000;
const NONE: readonly SessionCommand[] = [];

type Ending = Exclude<CommandStatus, 'running'>;

export class Commands {
  private readonly lists = new Map<string, readonly SessionCommand[]>();
  /** What each command printed, by session, then command id: streamed (Codex) or its tool result. */
  private readonly outputs = new Map<string, Map<string, string>>();
  /** How background work ended, by session, then task id, until the list drops it. */
  private readonly endings = new Map<string, Map<string, Ending>>();
  /** The file each background command's output goes to, by session, then command id, when the agent named one. */
  private readonly files = new Map<string, Map<string, string>>();
  /** Sessions whose list is sample data, not an agent's. */
  private readonly samples = new Set<string>();

  constructor(
    private readonly now: () => number,
    private readonly emit: (sessionId: string, patch: LivePatch) => void,
    /** A session's list or output changed: whoever stores it should store it again. */
    private readonly changed: (sessionId: string) => void = () => undefined,
    /** How many commands a session keeps (Settings → Workflow; 0 for every one). Read on each change. */
    private readonly kept: () => number = () => DEFAULT_COMMANDS_KEPT,
  ) {}

  /** What to store with the session: its commands and the end of what each printed. Nothing for sample data or an empty list. */
  stored(sessionId: string): StoredCommands | undefined {
    const list = this.lists.get(sessionId);
    if (!list || list.length === 0 || this.samples.has(sessionId)) return undefined;
    const outputs = this.outputs.get(sessionId);
    return { list: [...list], outputs: Object.fromEntries([...(outputs ?? [])].map(([id, text]) => [id, text.slice(-STORED_OUTPUT_CHARS)])) };
  }

  /** Bring back what was stored, for a session that has no list in this server run: once, and nothing if it already has one. */
  restore(sessionId: string, stored: StoredCommands | undefined): void {
    if (!stored || this.lists.has(sessionId)) return;
    const back = restoredCommands(stored, this.now());
    if (back.list.length === 0) return;
    const list = keepRecent(back.list, this.kept());
    const ids = new Set(list.map((c) => c.id));
    this.lists.set(sessionId, list);
    this.outputs.set(sessionId, new Map(Object.entries(back.outputs).filter(([id]) => ids.has(id))));
  }

  list(sessionId: string): SessionCommand[] {
    return [...(this.lists.get(sessionId) ?? NONE)];
  }

  /**
   * Take one agent event. `agentLabel` names the agent in what a row says when it cannot be stopped;
   * `handle` is asked for a background command's last output as it ends.
   */
  apply(sessionId: string, agentLabel: string, event: AgentEvent, handle: AgentHandle | null | undefined): void {
    const list = this.lists.get(sessionId) ?? NONE;
    const now = this.now();
    switch (event.type) {
      case 'tool':
        // Only a starting call says it runs a command; its result is matched by id (Claude's carries no command line).
        if (event.status === 'started' ? event.command === undefined : !list.some((c) => c.id === event.id)) return;
        if (event.status === 'started' && event.command !== undefined) return this.set(sessionId, commandStarted(list, { id: event.id, description: event.command, command: event.command, ...(event.label ? { label: event.label } : {}) }, now, noStopText(agentLabel)));
        if (!event.inBackground && event.detail) this.write(sessionId, event.id, event.detail, false);
        if (event.outputFile) this.fileFor(sessionId, event.id, event.outputFile);
        return this.set(sessionId, commandReturned(list, event.id, event.status === 'finished', event.inBackground === true, now, event.outputFile ? taskIdOfOutput(event.outputFile) : undefined));
      case 'tool-output':
        if (list.some((c) => c.id === event.id)) this.write(sessionId, event.id, event.delta, true);
        return;
      case 'background-tasks':
        return this.set(sessionId, backgroundListed(list, event.tasks, now, this.endings.get(sessionId)));
      case 'background-ended': {
        this.endingsOf(sessionId).set(event.taskId, event.status);
        const command = list.find((c) => c.taskId === event.taskId);
        if (command && event.outputFile) this.fileFor(sessionId, command.id, event.outputFile);
        // Read the end of its output while it can still be had.
        if (command && (this.files.get(sessionId)?.has(command.id) || handle?.backgroundOutput)) void this.keepFinalOutput(sessionId, command.id, event.taskId, handle);
        return this.set(sessionId, backgroundEnded(list, event.taskId, event.status, now));
      }
      case 'started':
      case 'done':
        return this.endAll(sessionId, 'stopped');
      case 'failed':
        return this.endAll(sessionId, 'failed');
      default:
    }
  }

  /** The agent's process ended or restarted, or the session was stopped: nothing it ran is still running. */
  endAll(sessionId: string, status: Ending): void {
    const list = this.lists.get(sessionId) ?? NONE;
    this.endings.delete(sessionId);
    this.set(sessionId, allEnded(list, status, this.now()));
  }

  /** The running command that is the agent's task `taskId`, if any. */
  runningTask(sessionId: string, taskId: string): SessionCommand | undefined {
    return (this.lists.get(sessionId) ?? NONE).find((c) => c.taskId === taskId && c.status === 'running');
  }

  /** The file the task `taskId`'s output goes to, when its agent named one. */
  outputFileOf(sessionId: string, taskId: string): string | undefined {
    const command = (this.lists.get(sessionId) ?? NONE).find((c) => c.taskId === taskId);
    return command ? this.files.get(sessionId)?.get(command.id) : undefined;
  }

  /** The task `taskId` ended, as Kestrel found when stopping it: its row says so now, not when the agent next reports. */
  taskEnded(sessionId: string, taskId: string, status: Ending): void {
    this.set(sessionId, backgroundEnded(this.lists.get(sessionId) ?? NONE, taskId, status, this.now()));
  }

  /** SAMPLE: a list and its output for a session with no agent behind it, so the pane shows in fake mode. */
  showSample(sessionId: string, commands: readonly SessionCommand[], outputs: Readonly<Record<string, string>>): void {
    this.lists.set(sessionId, [...commands]);
    this.outputs.set(sessionId, new Map(Object.entries(outputs)));
    this.samples.add(sessionId);
  }

  /** SAMPLE: stopping a sample command just marks it stopped. False when the session's list is not sample data. */
  stopSample(sessionId: string, commandId: string): boolean {
    if (!this.samples.has(sessionId)) return false;
    const list = this.lists.get(sessionId) ?? NONE;
    const taskId = list.find((c) => c.id === commandId)?.taskId;
    if (taskId) this.set(sessionId, backgroundEnded(list, taskId, 'stopped', this.now()));
    return true;
  }

  /** The session is gone. */
  forget(sessionId: string): void {
    this.samples.delete(sessionId);
    this.lists.delete(sessionId);
    this.outputs.delete(sessionId);
    this.endings.delete(sessionId);
    this.files.delete(sessionId);
  }

  /**
   * What one command printed, as the pane shows it. Claude's background work is asked for while it
   * runs; everything else is what was collected. Refused for a command this session does not list.
   */
  async output(sessionId: string, commandId: string, handle: AgentHandle | null | undefined, agentLabel: string): Promise<CommandOutput> {
    const command = (this.lists.get(sessionId) ?? NONE).find((c) => c.id === commandId);
    if (!command) throw new Refused('That command is not listed for this session any more.');
    const file = this.files.get(sessionId)?.get(commandId);
    if (file && (command.status === 'running' || !this.outputs.get(sessionId)?.has(commandId))) {
      try {
        const read = await readOutputTail(file, OUTPUT_MAX_CHARS);
        return withNote(this.shown(plainOutput(read.text)), read.truncated, command.status === 'running' ? 'It has printed nothing yet.' : 'It printed nothing.');
      } catch {
        // Gone or unreadable: fall back to asking the agent, then to what was collected.
      }
    }
    if (command.status === 'running' && command.taskId && handle?.backgroundOutput) {
      try {
        const asked = await handle.backgroundOutput(command.taskId);
        return withNote(this.shown(plainOutput(asked.text)), asked.truncated, 'It has printed nothing yet.');
      } catch (error) {
        return { text: this.collected(sessionId, commandId).text, truncated: false, note: `${agentLabel} could not say what it printed: ${reasonOf(error)}` };
      }
    }
    const collected = this.collected(sessionId, commandId);
    if (collected.text) return collected;
    if (command.status === 'running') return { text: '', truncated: false, note: command.taskId ? `${agentLabel} cannot be asked what this printed.` : streamsOutput(agentLabel) ? 'It has printed nothing yet.' : `${agentLabel} shows a command’s output when it finishes.` };
    return { text: '', truncated: false, note: 'It printed nothing.' };
  }

  private collected(sessionId: string, commandId: string): CommandOutput {
    return this.shown(plainOutput(this.outputs.get(sessionId)?.get(commandId) ?? ''));
  }

  private shown(text: string): CommandOutput {
    return tail(text, OUTPUT_MAX_CHARS);
  }

  private async keepFinalOutput(sessionId: string, commandId: string, taskId: string, handle: AgentHandle | null | undefined): Promise<void> {
    const file = this.files.get(sessionId)?.get(commandId);
    const reads = [...(file ? [() => readOutputTail(file, OUTPUT_MAX_CHARS)] : []), ...(handle?.backgroundOutput ? [() => handle.backgroundOutput!(taskId)] : [])];
    for (const read of reads) {
      try {
        const got = await read();
        if (got.text) return this.write(sessionId, commandId, got.text, false);
      } catch {
        // Gone, or the process cannot say: try the next way; with none left the pane says it printed nothing it can show.
      }
    }
  }

  private fileFor(sessionId: string, commandId: string, path: string): void {
    if (!isTaskOutputPath(path)) return;
    let byCommand = this.files.get(sessionId);
    if (!byCommand) this.files.set(sessionId, (byCommand = new Map()));
    byCommand.set(commandId, path);
  }

  private write(sessionId: string, commandId: string, text: string, append: boolean): void {
    let byCommand = this.outputs.get(sessionId);
    if (!byCommand) this.outputs.set(sessionId, (byCommand = new Map()));
    const next = append ? (byCommand.get(commandId) ?? '') + text : text;
    byCommand.set(commandId, next.length > OUTPUT_MAX_CHARS * 2 ? next.slice(next.length - OUTPUT_MAX_CHARS) : next);
    this.changed(sessionId);
  }

  private endingsOf(sessionId: string): Map<string, Ending> {
    let map = this.endings.get(sessionId);
    if (!map) this.endings.set(sessionId, (map = new Map()));
    return map;
  }

  private set(sessionId: string, all: SessionCommand[]): void {
    const next = keepRecent(all, this.kept());
    const previous = this.lists.get(sessionId) ?? NONE;
    if (sameList(previous, next)) return;
    if (next.length === 0) this.lists.delete(sessionId);
    else this.lists.set(sessionId, next);
    // Output of commands no longer listed goes with them.
    const kept = new Set(next.map((c) => c.id));
    const byCommand = this.outputs.get(sessionId);
    if (byCommand) for (const id of byCommand.keys()) if (!kept.has(id)) byCommand.delete(id);
    const files = this.files.get(sessionId);
    if (files) for (const id of files.keys()) if (!kept.has(id)) files.delete(id);
    this.emit(sessionId, { commands: next });
    this.changed(sessionId);
  }
}

/** Agents whose commands stream their output as it is printed. */
const streamsOutput = (agentLabel: string): boolean => agentLabel === 'Codex';

/** Why a command a turn is running cannot be stopped on its own. */
export const noStopText = (agentLabel: string): string => `${agentLabel} can only stop this by stopping the whole turn (Stop under the message box).`;

function withNote(output: CommandOutput, truncated: boolean, empty: string): CommandOutput {
  const result = { ...output, truncated: output.truncated || truncated };
  return result.text ? result : { ...result, note: empty };
}

const sameList = (a: readonly SessionCommand[], b: readonly SessionCommand[]): boolean => a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
