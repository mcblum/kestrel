// What `kestrel` (or its old name `kestrel-node`) was typed as: pure, so it is tested without a process. No argument
// is the overview (a line of status and the commands). `kestrel` takes `upgrade [version]`, `version`, `help [command]`
// and the `node` group: `kestrel node <command>` is a worker node's command from the closed lists
// (shared/node-commands.ts), and `kestrel node run` starts the node in this terminal (what the service's unit runs).
// `kestrel node` alone lists the group's commands. The words the first version took with no group (`kestrel-node run`,
// `kestrel status`, `kestrel setup`) are still taken as the node's (`OLD_NODE_WORDS`): a node installed before has a unit
// that runs `kestrel-node run` and an install script that runs `kestrel setup`. Anything else is refused with the reason.
// Only `logs`, `agents`, `git` (--yes, --manual), `status` (--json) and `upgrade` (a version) take more words.
import type { Agent } from '../model.ts';
import { NODE_CLI, NODE_GROUP, NODE_GROUP_COMMAND_NAMES, OLD_NODE_WORDS, TOP_COMMAND_NAMES, type NodeCommand, type TerminalCommand } from '../shared/node-commands.ts';

export interface LogOptions {
  /** Keep printing what is written (`-f`). */
  follow: boolean;
  /** How many of the last lines to print first. */
  lines: number;
}

export const DEFAULT_LOG_LINES = 200;
export const MAX_LOG_LINES = 100_000;

export type CliCommand = NodeCommand | TerminalCommand;

/** `agents`'s choices (agents-checklist.ts). `yes` is `--yes`; whether there is a terminal is decided where it runs. */
export interface AgentsArgs {
  only: Agent | null;
  yes: boolean;
  check: boolean;
}

/** What help can be asked about: a command, `run`, `version`, or the `node` group as a whole. */
export type HelpTopic = CliCommand | 'run' | 'version' | 'node';

/** Which list a mistake is followed by: `kestrel`'s own, or the `node` group's. */
export type UsageScope = 'top' | 'node';

export type CliAction =
  | { action: 'run' }
  | { action: 'overview' }
  | { action: 'version' }
  | { action: 'command'; command: CliCommand; logs?: LogOptions; agents?: AgentsArgs; git?: GitArgs; json?: boolean; version?: string }
  | { action: 'help'; command?: HelpTopic }
  | { action: 'error'; reason: string; scope: UsageScope };

/** A version as the install script takes it: 1.2.3 or 1.2.3-beta.4. */
export const isNodeVersion = (value: string): boolean => /^\d+\.\d+\.\d+(-beta\.\d+)?$/.test(value);

/** `git`'s choices (git-checklist.ts): `--yes` asks nothing; `--manual` does every host by hand; whether there is a terminal is decided where it runs. */
export interface GitArgs {
  yes: boolean;
  manual: boolean;
}

const AGENT_WORDS: readonly Agent[] = ['claude', 'codex', 'opencode'];

/** `agents`'s words: at most one agent (claude, codex, opencode), `--yes` (or `-y`) and `--check`, in any order. */
export function parseAgentsArgs(args: readonly string[]): { ok: true; options: AgentsArgs } | { ok: false; reason: string } {
  let only: Agent | null = null;
  let yes = false;
  let check = false;
  for (const arg of args) {
    if (arg === '--yes' || arg === '-y') yes = true;
    else if (arg === '--check') check = true;
    else if ((AGENT_WORDS as readonly string[]).includes(arg) && only === null) only = arg as Agent;
    else if ((AGENT_WORDS as readonly string[]).includes(arg)) return { ok: false, reason: '"agents" takes one agent at a time.' };
    else return { ok: false, reason: `"agents" does not take "${arg.slice(0, 40)}". It takes an agent (claude, codex or opencode), --yes and --check.` };
  }
  return { ok: true, options: { only, yes, check } };
}

const notACommand = (given: string): string => `"${given.slice(0, 40)}" is not a ${NODE_CLI} command. The commands are ${TOP_COMMAND_NAMES.join(', ')}.`;
const notANodeCommand = (given: string): string =>
  `"${given.slice(0, 40)}" is not a ${NODE_CLI} ${NODE_GROUP} command. The commands are ${[...NODE_GROUP_COMMAND_NAMES, 'run'].join(', ')}.`;

/** `logs`'s options: `-f`/`--follow`, `-n <lines>`/`--lines <lines>` (or `-n500`, `--lines=500`). */
export function parseLogOptions(args: readonly string[]): { ok: true; options: LogOptions } | { ok: false; reason: string } {
  let follow = false;
  let lines = DEFAULT_LOG_LINES;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-f' || arg === '--follow') {
      follow = true;
      continue;
    }
    let given: string | undefined;
    if (arg === '-n' || arg === '--lines') given = args[++i];
    else if (arg.startsWith('--lines=')) given = arg.slice('--lines='.length);
    else if (/^-n\d/.test(arg)) given = arg.slice(2);
    else return { ok: false, reason: `"logs" does not take "${arg.slice(0, 40)}". It takes -f (follow) and -n <lines>.` };
    const count = given === undefined || given === '' ? Number.NaN : Number(given);
    if (!Number.isInteger(count) || count < 0 || count > MAX_LOG_LINES) return { ok: false, reason: `-n takes a number of lines from 0 to ${MAX_LOG_LINES}.` };
    lines = count;
  }
  return { ok: true, options: { follow, lines } };
}

const HELP_WORDS: readonly string[] = ['help', '--help', '-h'];
const isHelpWord = (word: string | undefined): boolean => word !== undefined && HELP_WORDS.includes(word);
const asksHelp = (rest: readonly string[]): boolean => rest.length === 1 && (rest[0] === '--help' || rest[0] === '-h');

/** The node command an old or grouped word names (`setup` is `configure`), or null. */
const nodeWord = (word: string | undefined): CliCommand | 'run' | null => (word !== undefined && Object.hasOwn(OLD_NODE_WORDS, word) ? OLD_NODE_WORDS[word]! : null);

const fail = (reason: string, scope: UsageScope): CliAction => ({ action: 'error', reason, scope });

export function parseCliArgs(args: readonly string[]): CliAction {
  const [first, ...rest] = args;
  if (first === undefined) return { action: 'overview' };
  if (isHelpWord(first)) return helpOf(rest);
  if (first === 'version' || first === '--version') {
    if (asksHelp(rest)) return { action: 'help', command: 'version' };
    return rest.length === 0 ? { action: 'version' } : fail('"version" takes no arguments.', 'top');
  }
  if (first === 'upgrade') return upgradeOf(rest);
  if (first === NODE_GROUP) return parseNodeArgs(rest);
  // The first version's words, with no group: what an installed node's unit and install script still type.
  if (nodeWord(first)) return parseNodeArgs(args);
  return fail(notACommand(first), 'top');
}

function upgradeOf(rest: readonly string[]): CliAction {
  if (asksHelp(rest)) return { action: 'help', command: 'upgrade' };
  if (rest.length === 0) return { action: 'command', command: 'upgrade' };
  if (rest.length === 1 && isNodeVersion(rest[0]!)) return { action: 'command', command: 'upgrade', version: rest[0]! };
  return fail('"upgrade" takes one version, like 0.0.34 or 0.0.34-beta.1, or none for the newest.', 'top');
}

/** What follows `kestrel node` (or an old word with no group). */
export function parseNodeArgs(args: readonly string[]): CliAction {
  const [first, ...rest] = args;
  if (first === undefined) return { action: 'help', command: 'node' };
  if (isHelpWord(first)) return rest.length === 0 ? { action: 'help', command: 'node' } : nodeHelpOf(rest);
  if (first === 'upgrade') return upgradeOf(rest);
  const command = nodeWord(first);
  if (!command) return fail(notANodeCommand(first), 'node');
  if (asksHelp(rest)) return { action: 'help', command };
  if (command === 'run') return rest.length === 0 ? { action: 'run' } : fail('"run" takes no arguments.', 'node');
  return commandOf(command, rest);
}

/** One node command and the words after it. */
function commandOf(command: CliCommand, rest: readonly string[]): CliAction {
  if (command === 'logs') {
    const parsed = parseLogOptions(rest);
    return parsed.ok ? { action: 'command', command: 'logs', logs: parsed.options } : fail(parsed.reason, 'node');
  }
  if (command === 'agents') {
    const parsed = parseAgentsArgs(rest);
    return parsed.ok ? { action: 'command', command: 'agents', agents: parsed.options } : fail(parsed.reason, 'node');
  }
  if (command === 'status' && rest.length > 0) {
    return rest.length === 1 && rest[0] === '--json' ? { action: 'command', command: 'status', json: true } : fail('"status" takes only --json.', 'node');
  }
  if (command === 'git') {
    const known = new Set(['--yes', '-y', '--manual']);
    const wrong = rest.filter((a) => !known.has(a));
    if (wrong.length === 0) return { action: 'command', command: 'git', git: { yes: rest.includes('--yes') || rest.includes('-y'), manual: rest.includes('--manual') } };
    return fail(`"git" does not take "${wrong.join(' ').slice(0, 40)}". It takes --yes and --manual.`, 'node');
  }
  return rest.length === 0 ? { action: 'command', command } : fail(`"${command}" takes no arguments.`, 'node');
}

/** `kestrel help [topic]`: `kestrel`'s own list, `node` (and `node <command>`), `upgrade`, `version`, or an old word. */
function helpOf(rest: readonly string[]): CliAction {
  if (rest.length === 0) return { action: 'help' };
  const [word, ...more] = rest;
  if (word === NODE_GROUP) return more.length === 0 ? { action: 'help', command: 'node' } : nodeHelpOf(more);
  if (rest.length === 1 && (word === 'upgrade' || word === 'version')) return { action: 'help', command: word };
  if (rest.length === 1 && isHelpWord(word)) return { action: 'help' };
  if (rest.length === 1 && nodeWord(word)) return { action: 'help', command: nodeWord(word)! };
  return fail(notACommand(rest.join(' ')), 'top');
}

/** `kestrel node help <command>`. */
function nodeHelpOf(rest: readonly string[]): CliAction {
  const command = rest.length === 1 ? nodeWord(rest[0]) : null;
  return command ? { action: 'help', command } : fail(notANodeCommand(rest.join(' ')), 'node');
}
