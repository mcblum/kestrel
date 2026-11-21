// A session's commands: every shell command or watcher its agent is running, or ran, in this
// server's lifetime, whichever way the agent started it (design doc, "The Commands pane"). Kestrel
// does not model foreground versus background: a command is running until it ends, and one the
// agent left running past its tool call stays listed as running. Built from what the agents report:
// tool calls that run a command, the background work list, and how each piece of it ended. Pure:
// the clock is passed in, and every function returns a new list.
import type { BackgroundKind, BackgroundTask } from './background-tasks.ts';

export type CommandStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface SessionCommand {
  /** The tool call that started it, or `task:<id>` for background work whose tool call was not seen. */
  id: string;
  kind: BackgroundKind;
  /** The agent's own description of it (for a shell command, often the command line). */
  description: string;
  /** What the agent said the tool call does ("Start the API dev server"), when it said. */
  label?: string;
  /** The full command line, when it ran one. */
  command?: string;
  status: CommandStatus;
  /** Epoch milliseconds: when Kestrel first saw it running. */
  since: number;
  /** Epoch milliseconds: when Kestrel saw it end. */
  endedAt?: number;
  /** The agent's id for work it left running: what stopping it and reading its output need. */
  taskId?: string;
  /**
   * The id came from the output file its call's result named, and the agent has not listed the
   * work: its absence from the agent's list does not mean it ended (a resumed Claude CLI did not
   * list a task it started, seen live 2026-11-19). It ends when the agent says so or the run ends.
   */
  unlisted?: true;
  /** Why it cannot be stopped from Kestrel while it runs; absent when it can. */
  noStop?: string;
}

/** A command a tool call started, as the agent reported the call. */
export interface StartedCommand {
  id: string;
  label?: string;
  command?: string;
  description: string;
}

/** Background work as the agent lists it, with the tool call that started it when known. */
export type ListedWork = BackgroundTask;

/**
 * Commands kept per session (Settings → Workflow → Commands kept per session, Matt, 2026-11-19): the
 * most recent 50 unless changed, 0 for every one. Running ones are always kept (they can still be
 * stopped); ended ones fill the rest (`keepRecent`). 10, fixed, before 0.0.19.
 */
export const DEFAULT_COMMANDS_KEPT = 50;
export const MAX_COMMANDS_KEPT = 1000;

/** Why `value` cannot be the number of commands kept, or null when it can. Pure. */
export function commandsKeptProblem(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return 'Enter a whole number.';
  if (value < 0 || value > MAX_COMMANDS_KEPT) return `Enter 0 (keep every command) to ${MAX_COMMANDS_KEPT}.`;
  return null;
}

/** The list in its order (running first), with only the `kept` most recent ended ones; 0 keeps them all. Pure. */
export function keepRecent(list: readonly SessionCommand[], kept: number): SessionCommand[] {
  if (kept <= 0) return [...list];
  const running = list.filter((c) => c.status === 'running').length;
  const room = Math.max(0, kept - running);
  let ended = 0;
  return list.filter((c) => c.status === 'running' || ended++ < room);
}

/** How a row names its status: a command that finished is Done, one that failed is Error. */
export const STATUS_LABEL: Record<CommandStatus, string> = { running: 'Running', completed: 'Done', failed: 'Error', stopped: 'Stopped' };
/** How the details line says it ended, before "after <time>". */
export const ENDED_TEXT: Record<Exclude<CommandStatus, 'running'>, string> = { completed: 'done', failed: 'ended with an error', stopped: 'stopped' };

/** Running ones first (newest first), then ended ones (most recently ended first). How many are kept is `keepRecent`'s. */
function tidy(list: readonly SessionCommand[]): SessionCommand[] {
  const running = list.filter((c) => c.status === 'running').sort((a, b) => b.since - a.since);
  const ended = list.filter((c) => c.status !== 'running').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  return [...running, ...ended];
}

const replaceOne = (list: readonly SessionCommand[], id: string, change: (c: SessionCommand) => SessionCommand): SessionCommand[] => list.map((c) => (c.id === id ? change(c) : c));

const ended = (c: SessionCommand, status: Exclude<CommandStatus, 'running'>, now: number): SessionCommand => {
  const { noStop: _noStop, unlisted: _unlisted, ...rest } = c;
  return { ...rest, status, endedAt: now };
};

/** A tool call started a command. `noStop` says why it cannot be stopped on its own while the turn runs. Already listed: unchanged. */
export function commandStarted(list: readonly SessionCommand[], started: StartedCommand, now: number, noStop: string | undefined): SessionCommand[] {
  if (list.some((c) => c.id === started.id)) return [...list];
  const command: SessionCommand = { ...started, kind: 'command', status: 'running', since: now, ...(noStop ? { noStop } : {}) };
  return tidy([...list, command]);
}

/**
 * The tool call that started a command returned. A command sent to the background keeps running
 * (until the background list drops it); any other one ended, completed or failed. A command sent to
 * the background whose result named its output file gets the task id that file carries
 * (`taskId`), so it can be stopped even if the agent never lists it.
 */
export function commandReturned(list: readonly SessionCommand[], id: string, ok: boolean, inBackground: boolean, now: number, taskId?: string): SessionCommand[] {
  const found = list.find((c) => c.id === id);
  if (!found || found.status !== 'running' || found.taskId) return [...list];
  if (inBackground && taskId) {
    return tidy(
      replaceOne(list, id, (c) => {
        const { noStop: _noStop, ...rest } = c;
        return { ...rest, taskId, unlisted: true };
      }),
    );
  }
  if (inBackground) return [...list];
  return tidy(replaceOne(list, id, (c) => ended(c, ok ? 'completed' : 'failed', now)));
}

/**
 * The agent's whole list of work it left running. Each piece joins the command its tool call
 * started (it can be stopped and read from now on) or is added. A command that was background
 * work and is no longer listed has ended: as `endings` says, else completed.
 */
export function backgroundListed(list: readonly SessionCommand[], work: readonly ListedWork[], now: number, endings: ReadonlyMap<string, Exclude<CommandStatus, 'running'>> = new Map()): SessionCommand[] {
  const listedIds = new Set(work.map((w) => w.id));
  let next = list.map((c) => (c.taskId && !c.unlisted && c.status === 'running' && !listedIds.has(c.taskId) ? ended(c, endings.get(c.taskId) ?? 'completed', now) : c));
  for (const w of work) {
    // The tool call's command wins: the agent can list a task before it says which call started it,
    // and the entry added for it then merges into that call's command.
    const match = (w.toolId ? next.find((c) => c.id === w.toolId) : undefined) ?? next.find((c) => c.taskId === w.id);
    if (match) next = next.filter((c) => c.id === match.id || c.taskId !== w.id);
    const details = { kind: w.kind, description: w.description || match?.description || '', ...(w.label ? { label: w.label } : {}), ...(w.command ? { command: w.command } : {}) };
    if (match) {
      next = replaceOne(next, match.id, (c) => {
        const { noStop: _noStop, endedAt: _endedAt, unlisted: _unlisted, ...rest } = c;
        return { ...rest, ...details, taskId: w.id, status: 'running' };
      });
    } else next = [...next, { id: `task:${w.id}`, ...details, taskId: w.id, status: 'running', since: now }];
  }
  return tidy(next);
}

/** One piece of background work ended, as the agent says. Unknown or already ended: unchanged. */
export function backgroundEnded(list: readonly SessionCommand[], taskId: string, status: Exclude<CommandStatus, 'running'>, now: number): SessionCommand[] {
  const found = list.find((c) => c.taskId === taskId && c.status === 'running');
  if (!found) return [...list];
  return tidy(replaceOne(list, found.id, (c) => ended(c, status, now)));
}

/** The run ended or the agent's process went away: whatever was still running ended with it. */
export function allEnded(list: readonly SessionCommand[], status: Exclude<CommandStatus, 'running'>, now: number): SessionCommand[] {
  if (!list.some((c) => c.status === 'running')) return [...list];
  return tidy(list.map((c) => (c.status === 'running' ? ended(c, status, now) : c)));
}

export const runningCount = (list: readonly SessionCommand[]): number => list.filter((c) => c.status === 'running').length;

/** A command's output as the Commands pane shows it. */
export interface CommandOutput {
  /** The end of what it printed, escape sequences removed. Empty when there is nothing yet. */
  text: string;
  /** `text` is only the end of a longer output. */
  truncated: boolean;
  /** Why there is no output to show yet, when there is none. */
  note?: string;
}

// Terminal escape sequences: colours and cursor movement (CSI), titles (OSC), and lone ESC pairs.
// eslint-disable-next-line no-control-regex
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** Output as plain text: escape sequences removed, carriage-return redraws kept to their last state. Pure. */
export function plainOutput(raw: string): string {
  return raw
    .replace(ESCAPES, '')
    .split('\n')
    .map((line) => (line.includes('\r') ? (line.replace(/\r+$/, '').split('\r').pop() ?? '') : line))
    .join('\n');
}

/** The last `max` characters of `text`, and whether anything was cut. Pure. */
export function tail(text: string, max: number): { text: string; truncated: boolean } {
  return text.length <= max ? { text, truncated: false } : { text: text.slice(text.length - max), truncated: true };
}

/** How much of a command's output is stored with its session, from its end. */
export const STORED_OUTPUT_CHARS = 16_000;

/** A session's commands as stored with it: the list, and the end of what each printed. */
export interface StoredCommands {
  list: SessionCommand[];
  outputs: Record<string, string>;
}

/**
 * The commands as they come back after a restart: nothing an agent ran is still running, since its
 * process is gone, so a command stored as running is ended as stopped at `now`.
 */
export function restoredCommands(stored: StoredCommands, now: number): StoredCommands {
  const list = allEnded(stored.list, 'stopped', now);
  const listed = new Set(list.map((c) => c.id));
  return { list, outputs: Object.fromEntries(Object.entries(stored.outputs).filter(([id]) => listed.has(id))) };
}

/** A command that has ended can be run again by asking the agent; one still running cannot. */
export const canRetry = (command: Pick<SessionCommand, 'status'>): boolean => command.status !== 'running';

const RETRY_OUTPUT_LINES = 20;

/** Said of a command the agent had left running in the background, so the re-run is not waited on either. */
export const RETRY_IN_BACKGROUND = 'Run it in the background, as it ran before, and do not wait for it to finish.';

/**
 * What the agent is told when the user chooses "Retry command": the exact command, how it ended,
 * and for one that failed the end of what it printed, so the agent can fix the cause first. A
 * command that had gone to the background (`taskId`) is asked for in the background again: without
 * that the agent ran it in the foreground and the turn waited on it to the end (2026-11-18).
 */
export function retryMessage(command: Pick<SessionCommand, 'command' | 'description' | 'status' | 'taskId'>, output: string): string {
  const run = command.command ? `Run this command again:\n\n\`\`\`\n${command.command}\n\`\`\`` : `Run this again: ${command.description}`;
  const what = command.taskId ? `${run}\n\n${RETRY_IN_BACKGROUND}` : run;
  if (command.status !== 'failed') return command.status === 'stopped' ? `${what}\n\nIt was stopped before it finished.` : what;
  const lines = output.trimEnd().split('\n').slice(-RETRY_OUTPUT_LINES).join('\n');
  const printed = lines.trim() ? `\n\nIt failed last time. The end of what it printed:\n\n\`\`\`\n${lines}\n\`\`\`` : '\n\nIt failed last time and printed nothing I can show you.';
  return `${what}${printed}\n\nIf it would fail the same way, fix the cause first and say what you changed.`;
}
