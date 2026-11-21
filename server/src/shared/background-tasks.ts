// Work an agent left running in the background (a long command, a dev server, a watcher). The agent
// reports the whole list each time it changes; Kestrel keeps when each one was first seen, gives
// each a short readable name, and shows the list at the foot of the session. Pure: the clock is passed in.

/** What kind of work it is, in plain words. */
export type BackgroundKind = 'command' | 'watcher' | 'workflow' | 'tool' | 'other';

/** One piece of background work as the agent reports it. */
export interface BackgroundTask {
  /** The agent's own id for it; what stopping it needs. */
  id: string;
  kind: BackgroundKind;
  /** The agent's own description of the task: for a shell command, often the whole command line. */
  description: string;
  /** What the agent said the tool call that started it does ("Start the API dev server"), when it said. */
  label?: string;
  /** The full command line of that tool call, when it ran one. */
  command?: string;
  /** The tool call that started it, when known: ties it to that call's command. */
  toolId?: string;
}

/** One piece of background work as the session shows it: with when Kestrel first saw it running. */
export interface LiveBackgroundTask extends BackgroundTask {
  /** Epoch milliseconds. */
  since: number;
}

/** The SDK's task type for a helper (sub-agent). Helpers have their own card, so they are left out here. */
const HELPER_TASK_TYPE = 'local_agent';

/** The words for each kind, as a row shows them. */
export const KIND_LABEL: Record<BackgroundKind, string> = { command: 'Command', watcher: 'Watcher', workflow: 'Workflow', tool: 'Tool', other: 'Task' };

/**
 * The kind of an agent task type, or null for one that is shown elsewhere (a helper). Unknown types
 * are `other`, never dropped: anything still running is worth seeing.
 */
export function backgroundKind(taskType: string): BackgroundKind | null {
  if (taskType === HELPER_TASK_TYPE) return null;
  if (taskType === 'local_bash') return 'command';
  if (/monitor/i.test(taskType)) return 'watcher';
  if (taskType === 'local_workflow') return 'workflow';
  if (taskType === 'mcp_task') return 'tool';
  return 'other';
}

/** The new list, keeping when each task already listed was first seen; new ones are seen `now`. */
export function withFirstSeen(previous: readonly LiveBackgroundTask[], next: readonly BackgroundTask[], now: number): LiveBackgroundTask[] {
  const seen = new Map(previous.map((t) => [t.id, t.since]));
  return next.map((t) => ({ ...t, since: seen.get(t.id) ?? now }));
}

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;

/** How long it has been running, short: "<1m", "4m", "1h 5m", "2h". A clock running behind reads as "<1m". */
export function elapsedText(since: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - since) / MS_PER_MINUTE);
  if (minutes < 1) return '<1m';
  if (minutes < MINUTES_PER_HOUR) return `${minutes}m`;
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  const rest = minutes % MINUTES_PER_HOUR;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

const ELLIPSIS = '…';

/** The text cut in the middle to at most `max` characters, so both its start and its end show. */
export function middleTruncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  if (max <= ELLIPSIS.length) return ELLIPSIS.slice(0, max);
  const keep = max - ELLIPSIS.length;
  const head = Math.ceil(keep / 2);
  return `${clean.slice(0, head)}${ELLIPSIS}${clean.slice(clean.length - (keep - head))}`;
}

/** What a row says when there is no description. */
export const taskText = (task: BackgroundTask): string => task.description.trim() || `${KIND_LABEL[task.kind]} running in the background`;

// ---- readable names --------------------------------------------------------------------------
//
// A row leads with a short name; the full command line stays reachable (tooltip, and a muted line
// under the name). The name is the agent's own words for the tool call when it gave some, else one
// made from the command by `commandName`, which only ever keeps words that are in the command.

/** Longest name a row shows; longer ones end in an ellipsis. */
export const NAME_MAX_CHARS = 48;
/** At most this many plain words follow the program in a name made from a command. */
const NAME_MAX_WORDS = 3;

/** Commands that set the scene for the real one (`cd x && …`), never the thing that runs. */
const SETUP_PROGRAMS = new Set(['cd', 'pushd', 'popd', 'export', 'source', '.', 'set', 'unset', 'sleep', 'true', 'false', 'echo', 'printf', 'mkdir', 'wait', 'trap', 'ulimit', 'umask']);
/** Words in front of the real program that only change how it runs. */
const WRAPPERS = new Set(['nohup', 'exec', 'time', 'env', 'command', 'sudo', 'nice']);
/** Package managers, whose workspace flag names the package a script runs in. */
const PACKAGE_MANAGERS = new Set(['pnpm', 'npm', 'yarn', 'bun']);
/** Their flags that name the package or folder (`--filter @app/api`). */
const TARGET_FLAGS = new Set(['--filter', '-F', '--workspace', '-C', '--dir', '--prefix', '--cwd']);
/** A flag's value rather than a word: it has a digit or a colon (`--port 5173`, `-p 3000:3000`). */
const FLAG_VALUE = /[\d:]/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** A redirection operator standing alone, whose target is the next word (`>`, `2>>`, `<`, `&>`). */
const REDIRECT_ALONE = /^(\d*|&)(>>?|<)$/;
/** A redirection with its target attached (`>log`, `2>&1`). */
const REDIRECT_ATTACHED = /^(\d*|&)(>>?|<)./;
/** A command line starts with a lower-case program or a path, perhaps after `NAME=value` settings. */
const COMMAND_START = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*[a-z0-9_.~/][\w.~/+-]*(\s|$)/;

/** The text on one line, cut at the end to at most `max` characters. */
export function clipEnd(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - ELLIPSIS.length))}${ELLIPSIS}`;
}

/** Collects words and simple commands as `splitCommand` reads a line. */
class Splitter {
  readonly segments: string[][] = [];
  private words: string[] = [];
  private word = '';
  private inWord = false;

  add(text: string): void {
    this.word += text;
    this.inWord = true;
  }
  endWord(): void {
    if (this.inWord) this.words.push(this.word);
    this.word = '';
    this.inWord = false;
  }
  endSegment(): void {
    this.endWord();
    if (this.words.length) this.segments.push(this.words);
    this.words = [];
  }
}

/**
 * A shell command line as its simple commands, each a list of words: split at `&&`, `||`, `;`,
 * `|`, `&` and line ends, with quotes and backslashes taken off as the shell would. Not a full
 * shell parser: enough to find the command that matters. Pure.
 */
export function splitCommand(command: string): string[][] {
  const out = new Splitter();
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else out.add(c);
    } else if (c === "'" || c === '"') {
      quote = c;
      out.add('');
    } else if (c === '\\') out.add(command[++i] ?? '');
    else if (c === '\n' || c === ';') out.endSegment();
    else if (/\s/.test(c)) out.endWord();
    else if (c === '|' || (c === '&' && command[i + 1] === '&')) {
      out.endSegment();
      if (command[i + 1] === c) i++;
    } else if (c === '&' && command[i - 1] !== '>' && command[i + 1] !== '>') out.endSegment();
    else out.add(c);
  }
  out.endSegment();
  return out.segments;
}

/** The words of one simple command without redirections, leading `NAME=value` settings, wrappers (`nohup`, `env`) or anything after `--`. */
function coreWords(words: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === '--') break;
    if (REDIRECT_ALONE.test(w)) i++;
    else if (!REDIRECT_ATTACHED.test(w)) kept.push(w);
  }
  const preamble = (w: string, i: number) => ENV_ASSIGNMENT.test(w) || WRAPPERS.has(w) || (i > 0 && kept[i - 1] === 'env' && w.startsWith('-'));
  let start = 0;
  while (start < kept.length && preamble(kept[start]!, start)) start++;
  return kept.slice(start);
}

/** The last part of a path (`./scripts/dev.sh` → `dev.sh`); a word with no slash as it is. */
const lastPart = (word: string): string => word.replace(/\/+$/, '').split('/').pop() || word;

/** One simple command, short: the program, its first few plain words, and the package it runs in. */
function nameOf(words: readonly string[]): string {
  const program = lastPart(words[0]!);
  const manager = PACKAGE_MANAGERS.has(program);
  const plain: string[] = [];
  let target: string | null = null;
  for (let i = 1; i < words.length && plain.length < NAME_MAX_WORDS; i++) {
    const w = words[i]!;
    if (!w.startsWith('-')) {
      if (!/^\d+$/.test(w)) plain.push(w.includes('/') && !w.startsWith('@') ? lastPart(w) : w);
      continue;
    }
    const at = w.indexOf('=');
    const flag = at < 0 ? w : w.slice(0, at);
    const next = words[i + 1];
    if (manager && TARGET_FLAGS.has(flag)) {
      target = at < 0 ? (next ?? null) : w.slice(at + 1);
      if (at < 0) i++;
    } else if (at < 0 && next !== undefined && !next.startsWith('-') && FLAG_VALUE.test(next)) i++;
  }
  return `${[program, ...plain].join(' ')}${target ? ` (${target})` : ''}`;
}

/**
 * A short name for a shell command line, made only of words in it: the command that matters (not
 * `cd`, `export`, a pipe's `tee`), without settings, redirections, flags and their values.
 * `pnpm --filter @app/api dev` → "pnpm dev (@app/api)"; `cd api && docker compose up -d db | tee
 * log` → "docker compose up db". Empty for an empty command. Pure.
 */
export function commandName(command: string): string {
  const simple = splitCommand(command).map(coreWords).filter((words) => words.length > 0);
  const main = simple.find((words) => !SETUP_PROGRAMS.has(words[0]!)) ?? simple[0];
  return main ? clipEnd(nameOf(main), NAME_MAX_CHARS) : '';
}

/** Whether a description reads as a command line rather than words for people (`pnpm dev`, not "Watch CI"). */
export const looksLikeCommand = (text: string): boolean => COMMAND_START.test(text.trim());

/** The full command line behind a task, if it ran one: the tool call's, or a description that is one. */
function fullCommand(task: BackgroundTask): string | null {
  if (task.command?.trim()) return task.command.trim();
  return task.kind === 'command' && looksLikeCommand(task.description) ? task.description.trim() : null;
}

/** What a row is called: the agent's own words for the call, else a name made from its command, else its description. Pure. */
export function taskName(task: BackgroundTask): string {
  if (task.label?.trim()) return clipEnd(task.label, NAME_MAX_CHARS);
  const command = fullCommand(task);
  const named = command ? commandName(command) : '';
  return named || taskText(task);
}

/** The full command line to show with the name, or null when there is none or it says no more than the name. Pure. */
export function taskCommand(task: BackgroundTask): string | null {
  const command = fullCommand(task);
  if (!command) return null;
  return command.replace(/\s+/g, ' ') === taskName(task) ? null : command;
}
