// The slash commands a Claude session offers (shared/slash-commands.ts). The SDK answers
// `supportedCommands()` on a live query: Claude Code's own commands and the user's skills, as the
// session's settings load them. The init message names the ones that only make sense in a
// terminal, which Kestrel leaves out. Checked live on SDK 0.3.322 (2026-11-18).
import { query, type Options, type Query } from '@anthropic-ai/claude-agent-sdk';
import { slashCommandsFrom, type SlashCommand } from '../../shared/slash-commands.ts';
import type { StartOptions } from '../types.ts';
import { baseOptions } from './options.ts';

const TIMEOUT_MS = 10_000;

/**
 * The commands that only make sense in a terminal, as Claude Code named them when asked
 * (2.1.322). A running session says which they are in its init message; a session asked without
 * running a turn sends no init message, so these stand in for it.
 */
export const KNOWN_TERMINAL_ONLY: readonly string[] = ['doctor', 'color', 'focus', 'reload-plugins'];

/**
 * Commands Claude Code lists that make no sense inside Kestrel, each with why. Gone through
 * against what an idle query lists on Claude Code 2.1.322 (55 commands, 2026-11-18). Everything
 * else is offered: when in doubt a command stays, since hiding one takes it away from the user.
 */
export const NOT_IN_KESTREL: Readonly<Record<string, string>> = {
  // Kestrel sets these itself, and a command would leave its own controls showing something else.
  model: 'the model picker under the message box sets it',
  effort: 'the effort control under the message box sets it',
  fast: 'the fast-mode control under the message box sets it',
  rename: 'the session is renamed in Kestrel (its tab or sidebar row)',
  clear: 'it starts another Claude session behind this Kestrel session; start a new session instead',
  mcp: "connectors are chosen per project in Kestrel (the project's agent setup)",
  // They act on Claude Code's own terminal screen or installation.
  config: "it opens Claude Code's settings screen",
  heapdump: "it dumps Claude Code's own memory to the Desktop",
  // Listed, but not commands any more, or only for sessions a server launched.
  agents: 'removed from Claude Code',
  'extra-usage': 'renamed to /usage-credits',
  '__remote-workflow': 'only for sessions a server launched',
  'workflow-launch-exec': 'only for sessions a server launched',
};

/** Every name the menu leaves out: the terminal-only ones the session (or `KNOWN_TERMINAL_ONLY`) names, and `NOT_IN_KESTREL`. */
export const leftOut = (terminalOnly: readonly string[]): string[] => [...new Set([...terminalOnly, ...Object.keys(NOT_IN_KESTREL)])];

/** The names the init message marks as terminal-only. */
export const terminalOnlyOf = (init: { terminal_slash_commands?: unknown }): string[] => (Array.isArray(init.terminal_slash_commands) ? init.terminal_slash_commands.filter((n): n is string => typeof n === 'string') : []);

/** Ask a live query for its commands, giving up after `ms`; null when it cannot say (an older CLI, a closed query, a test double). */
export async function askSlashCommands(q: Pick<Query, 'supportedCommands'> | null, terminalOnly: readonly string[], ms = TIMEOUT_MS): Promise<SlashCommand[] | null> {
  if (!q || typeof q.supportedCommands !== 'function') return null;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref();
  });
  try {
    const answer = await Promise.race([q.supportedCommands(), late]);
    return answer ? slashCommandsFrom(answer, terminalOnly) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** A prompt stream that never yields: the process starts and answers, and no turn runs. */
async function* idle(): AsyncGenerator<never> {
  await new Promise<never>(() => undefined);
}

/**
 * The commands a session would offer, asked without running a turn: for a session that has not run
 * since this was added, or not at all. A short query that sends nothing, with the session's own
 * settings (so the user's skills are in it) and no tools, MCP servers or hooks. Takes about half
 * a second (checked live on SDK 0.3.322).
 */
export async function claudeSlashCommands(opts: StartOptions, runQuery: typeof query = query): Promise<SlashCommand[] | null> {
  const base = baseOptions(opts);
  const options: Options = { ...base, mcpServers: {}, settings: { ...(typeof base.settings === 'object' ? base.settings : {}), disableAllHooks: true } };
  const q = runQuery({ prompt: idle() as never, options });
  try {
    return await askSlashCommands(q, leftOut(KNOWN_TERMINAL_ONLY));
  } finally {
    q.close();
  }
}
