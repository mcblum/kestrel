// What `kestrel-node` was typed as: pure, so it is tested without a process. No argument (or `run`) starts the
// node; a word from the closed lists (shared/node-commands.ts) is a command; anything else is refused with the
// reason. Only `logs`, `agents`, `git` (--yes, --manual) and `status` (--json) take options.
import type { Agent } from '../model.ts';
import { CLI_COMMAND_NAMES, isNodeCommand, isTerminalCommand, NODE_COMMANDS, TERMINAL_COMMANDS, type NodeCommand, type TerminalCommand } from '../shared/node-commands.ts';

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

export type CliAction = { action: 'run' } | { action: 'command'; command: CliCommand; logs?: LogOptions; agents?: AgentsArgs; git?: GitArgs; json?: boolean } | { action: 'help' } | { action: 'error'; reason: string };

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

const notACommand = (given: string): string => `"${given.slice(0, 40)}" is not a kestrel-node command. The commands are ${CLI_COMMAND_NAMES.join(', ')}.`;

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

export function parseCliArgs(args: readonly string[]): CliAction {
  const [first, ...rest] = args;
  if (first === undefined || first === 'run') return rest.length === 0 ? { action: 'run' } : { action: 'error', reason: `"${first ?? 'run'}" takes no arguments.` };
  if (first === 'help' || first === '--help' || first === '-h') return { action: 'help' };
  if (first === 'logs') {
    const parsed = parseLogOptions(rest);
    return parsed.ok ? { action: 'command', command: 'logs', logs: parsed.options } : { action: 'error', reason: parsed.reason };
  }
  if (first === 'agents') {
    const parsed = parseAgentsArgs(rest);
    return parsed.ok ? { action: 'command', command: 'agents', agents: parsed.options } : { action: 'error', reason: parsed.reason };
  }
  if (first === 'status' && rest.length > 0) {
    return rest.length === 1 && rest[0] === '--json' ? { action: 'command', command: 'status', json: true } : { action: 'error', reason: '"status" takes only --json.' };
  }
  if (first === 'git') {
    const known = new Set(['--yes', '-y', '--manual']);
    const wrong = rest.filter((a) => !known.has(a));
    if (wrong.length === 0) return { action: 'command', command: 'git', git: { yes: rest.includes('--yes') || rest.includes('-y'), manual: rest.includes('--manual') } };
    return { action: 'error', reason: `"git" does not take "${wrong.join(' ').slice(0, 40)}". It takes --yes and --manual.` };
  }
  if (!isNodeCommand(first) && !isTerminalCommand(first)) return { action: 'error', reason: notACommand(first) };
  return rest.length === 0 ? { action: 'command', command: first } : { action: 'error', reason: `"${first}" takes no arguments.` };
}

const aboutOf = (command: CliCommand): string => (isTerminalCommand(command) ? TERMINAL_COMMANDS[command].about : NODE_COMMANDS[command].about);

export const usage = (): string =>
  [`Usage: kestrel-node [run | ${CLI_COMMAND_NAMES.join(' | ')}]`, '  run (or no argument)  start the node in this terminal', ...CLI_COMMAND_NAMES.map((name) => `  ${name.padEnd(21)} ${aboutOf(name)}`)].join('\n');
