// What a terminal may ask a worker node over its socket (docs/designs/worker-nodes.md, section 3): one closed
// list. The socket is not the HTTP listener and carries none of its routes. A command the design names but a
// later item builds is on the list from the start and answers with a plain refusal, so the list never grows
// by accident: adding to it is a design change.
//
// `kestrel` is a general command; the worker node's are under its `node` group (`kestrel node <command>`), and its old
// name `kestrel-node` still takes them as they were first typed, with no group (`kestrel-node run`). It takes more words
// than the socket answers. What must work while no node is running, or drives the others, is done by the terminal itself
// and never reaches the socket (`TERMINAL_COMMANDS`: `configure`, `start`, `logs`, `upgrade`); `status`, `stop`, `agents` and
// `uninstall` are begun in the terminal, which asks the running node for the part only it can do
// (node-control/terminal.ts). `agents` is the checklist: installing and signing in run in the terminal, which has the
// person's keyboard and screen (an agent's own sign-in needs a real terminal); the node's part is to forget what it
// knew of the agents that changed, ask them again, and say what it now publishes about each.

import type { Agent } from '../model.ts';
import { NODE_AGENTS_COMMAND, nodeAgentReason, type NodeAgentProblem } from './node-agents.ts';

export interface NodeCommandInfo {
  /** Built in this version. The rest answer `NOT_BUILT`. */
  built: boolean;
  /** One line for `--help` and for the refusal. */
  about: string;
}

export const NODE_COMMANDS = {
  status: { built: true, about: 'Say whether this node is running, signed in, in the account, and what it can do.' },
  stop: { built: true, about: 'End the sessions’ turns cleanly and stop the node.' },
  join: { built: true, about: 'Sign in and ask to join the account.' },
  // The node's part of `kestrel node agents`: ask the agents again (forgetting what it knew of those named in
  // `recheck`) and answer whether each can run, as it tells other devices. The checklist itself runs in the terminal.
  agents: { built: true, about: 'Install and sign in Claude Code, Codex and OpenCode on this node ([claude|codex|opencode] [--yes] [--check]).' },
  // The node's part of `kestrel node git`: read its git settings again (what Kestrel's git runs with) and say what only
  // it knows: the hosts of the account's projects, and the commit name, email and signing other computers publish.
  // Making the key, testing it and asking the person run in the terminal.
  git: { built: true, about: 'Make this node’s git key, check it at your git hosts, and set the commit name and email ([--yes]).' },
  // The node's part of `kestrel node uninstall`: refuse while a session has work that is not pushed, then leave the
  // account. Deleting the service and the folder is the terminal's part, once the node has stopped.
  uninstall: { built: true, about: 'Remove this node from the account and delete it from this computer.' },
} as const satisfies Record<string, NodeCommandInfo>;

export type NodeCommand = keyof typeof NODE_COMMANDS;

export const NODE_COMMAND_NAMES = Object.keys(NODE_COMMANDS) as readonly NodeCommand[];

export const isNodeCommand = (value: unknown): value is NodeCommand => typeof value === 'string' && Object.hasOwn(NODE_COMMANDS, value);

/**
 * What `kestrel` does in the terminal alone, with or without a node running. Never sent on the socket. `configure`
 * runs the other steps in order and asks the node only `status`; `upgrade` (`kestrel upgrade`, the one of these not in
 * the `node` group) runs the install script the bundle carries.
 */
export const TERMINAL_COMMANDS = {
  configure: { about: 'Set this node up, one step at a time: join your account, the agents, git, and what needs an administrator.' },
  start: { about: 'Start the node’s service (systemctl --user).' },
  logs: { about: 'Read the node’s log (-f to follow, -n <lines> for more or fewer).' },
  upgrade: { about: 'Install the newest version of this node’s channel (or the version given), as the install command does.' },
} as const;

export type TerminalCommand = keyof typeof TERMINAL_COMMANDS;

export const TERMINAL_COMMAND_NAMES = Object.keys(TERMINAL_COMMANDS) as readonly TerminalCommand[];

export const isTerminalCommand = (value: unknown): value is TerminalCommand => typeof value === 'string' && Object.hasOwn(TERMINAL_COMMANDS, value);

/** The command people type: `kestrel`. `kestrel-node`, its first name, still works (a node installed before has it). */
export const NODE_CLI = 'kestrel';

/** The group the worker node's commands are under: `kestrel node <command>`. */
export const NODE_GROUP = 'node';

/** A node command as it is typed in full, for every sentence that names one: `kestrel node agents`. */
export const nodeCommandLine = (command: string): string => `${NODE_CLI} ${NODE_GROUP} ${command}`;

/** Every command of the `node` group, in the order its list shows them: setting up first, then running, then the rest. */
export const NODE_GROUP_COMMAND_NAMES: readonly (NodeCommand | TerminalCommand)[] = ['configure', 'status', 'join', 'agents', 'git', 'start', 'stop', 'logs', 'uninstall'];

/** `kestrel`'s own commands, beside the `node` group, each with its line. */
export const TOP_COMMANDS = {
  node: { about: `This computer as a worker node: set it up, run it, and see how it is (${NODE_CLI} ${NODE_GROUP} <command>).` },
  upgrade: TERMINAL_COMMANDS.upgrade,
  version: { about: 'Print the version of Kestrel installed here.' },
  help: { about: `Say more about a command: ${NODE_CLI} help <command>.` },
} as const;

export type TopCommand = keyof typeof TOP_COMMANDS;

export const TOP_COMMAND_NAMES = Object.keys(TOP_COMMANDS) as readonly TopCommand[];

/** The words the first version took with no group (`kestrel-node run`, `kestrel setup`), still taken as the node's. */
export const OLD_NODE_WORDS: Readonly<Record<string, NodeCommand | TerminalCommand | 'run'>> = {
  setup: 'configure',
  run: 'run',
  ...Object.fromEntries(NODE_GROUP_COMMAND_NAMES.map((name) => [name, name])),
};

/** What a command does, in one line, from whichever list it is on. */
export const commandAbout = (command: NodeCommand | TerminalCommand): string => (isTerminalCommand(command) ? TERMINAL_COMMANDS[command].about : NODE_COMMANDS[command].about);

/** The refusal for a command the design names and a later item builds. */
export const notBuiltReason = (command: NodeCommand): string => `"${command}" is not built yet in this version of kestrel.`;

/** The refusal for anything not on the list. */
export const unknownCommandReason = (given: string): string => `"${given.slice(0, 40)}" is not a command the node answers. The commands are ${NODE_COMMAND_NAMES.join(', ')}.`;

/**
 * One request on the socket: a line of JSON, `{"command":"status"}`. `agents` alone may name the agents the terminal
 * just installed, signed in or checked: `{"command":"agents","recheck":["codex"]}`.
 */
export type NodeRequest = { command: string; recheck?: Agent[] };

/** What the node says about one agent: whether it can run, why not as it tells other devices, and why not as a value. */
export interface NodeAgentState {
  agent: Agent;
  canRun: boolean;
  why: string | null;
  /** Why not, as a value, for the node's own terminal to word (`whyHere`); null when it can run or did not say. */
  problem?: NodeAgentProblem | null;
}

/** Why an agent cannot run, in the node's own terminal: without "on <node> … there". Pure. */
export const whyHere = (state: NodeAgentState): string => (state.problem ? nodeAgentReason(state.agent, state.problem, 'here') : (state.why ?? 'It did not say why.'));

/**
 * One answer: a line of JSON. `status` carries the status; `stop` says it is stopping; `uninstall` says what it did;
 * `agents` carries what the node says about each agent.
 */
export type NodeReply<Status = unknown> = { ok: true; command: NodeCommand; status?: Status; message?: string; agents?: NodeAgentState[]; git?: NodeGitFacts } | { ok: false; reason: string };

/** What another computer of the account publishes about its git (its set-up record), for the node's checklist. */
export interface PublishedGit {
  /** The computer's name. */
  computer: string;
  name: string | null;
  email: string | null;
  signs: boolean;
}

/** What only the running node knows for `kestrel node git`. */
export interface NodeGitFacts {
  /** This node's name, as other devices see it. */
  name: string;
  /** The repositories of the account's projects (this node's and every other computer's), as `host/owner/name`. */
  repositories: string[];
  /**
   * Why the account's projects are not known yet (not in an account, not connected, the projects not read since it
   * connected), or null. While it is set `repositories` holds only what the node knows so far, never "none".
   */
  accountUnknown: string | null;
  /** What the account's other computers publish; empty when the node is not connected or in an account. */
  others: PublishedGit[];
  /** Why `others` is empty when it could have said more, or null. */
  othersUnknown: string | null;
}

const isAgentName = (value: unknown): value is Agent => value === 'claude' || value === 'codex' || value === 'opencode';

/** The agents an `agents` request names in `recheck`, or why the request is not one. Never throws. */
export function parseRecheck(line: string): { ok: true; recheck: Agent[] } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'That was not a request.' };
  }
  const given = typeof parsed === 'object' && parsed !== null ? (parsed as { recheck?: unknown }).recheck : undefined;
  if (given === undefined) return { ok: true, recheck: [] };
  if (!Array.isArray(given) || given.length > 3 || !given.every(isAgentName)) return { ok: false, reason: '"recheck" names agents: claude, codex, opencode.' };
  return { ok: true, recheck: [...new Set(given)] };
}

/** The longest request line the socket reads: a command name is short. */
export const NODE_REQUEST_MAX_BYTES = 1024;

/** A request line as a command name, or why it is not one. Never throws. */
export function parseNodeRequest(line: string): { ok: true; command: NodeCommand } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'That was not a request: send one line of JSON, like {"command":"status"}.' };
  }
  const given = typeof parsed === 'object' && parsed !== null ? (parsed as { command?: unknown }).command : undefined;
  if (typeof given !== 'string') return { ok: false, reason: 'A request names a command: {"command":"status"}.' };
  return isNodeCommand(given) ? { ok: true, command: given } : { ok: false, reason: unknownCommandReason(given) };
}

/**
 * `join` is a conversation, the one command that is (worker-nodes.md, section 5). After the request line the node
 * sends events, one line of JSON each, ending with `end`; the terminal sends one answer line for each `ask`, and
 * nothing else. The connection closing before `end` withdraws: a sign-in under way is cancelled and a request to
 * join is ended. Only the sign-in's short code and the two six-digit codes are ever in an event; never a token or key.
 *
 * The node decides what is said, the terminal only draws it (node-control/join-draw.ts). So an event says where it
 * belongs (`step`: 0 the title and the end, 1 sign in, 2 let this node in, 3 confirm) and what kind of line it is,
 * and the terminal lays it out: a heading, a plain line, a wait, a labelled field, a code on a line of its own, a
 * step done (a tick), a problem set off by blank lines.
 */
// The same events draw `kestrel node agents` (node-control/agents-checklist.ts), whose sections are 1 to 4, and
// `kestrel node git` (node-control/git-checklist.ts), whose sections are 1 to 6.
export const JOIN_STEPS = [0, 1, 2, 3, 4, 5, 6] as const;
export type JoinStep = (typeof JOIN_STEPS)[number];

// `quote`: a line a program printed, shown as it is under a problem (npm's last lines), never wrapped.
export const JOIN_TEXT_KINDS = ['heading', 'line', 'wait', 'done', 'problem', 'quote'] as const;
export type JoinTextKind = (typeof JOIN_TEXT_KINDS)[number];

export type JoinSay =
  | { kind: JoinTextKind; text: string }
  | { kind: 'field'; label: string; value: string; note?: string }
  | { kind: 'code'; code: string };

export type JoinSaid = JoinSay & { step: JoinStep };

export type NodeJoinEvent =
  | ({ event: 'say' } & JoinSaid)
  | { event: 'ask'; step: JoinStep; prompt: string }
  /** How it ended; `next` is the command to run next, when there is one. */
  | { event: 'end'; ok: boolean; text: string; next?: string };

/** What to run once a node is in: the agents' checklist. */
export const JOIN_NEXT = NODE_AGENTS_COMMAND;
/** What to run after a join that did not finish, when its reason does not already say. */
export const JOIN_AGAIN = nodeCommandLine('join');

/** What the terminal sends for an `ask`: one line of JSON, `{"answer":"157 640"}`. */
export interface NodeJoinAnswer {
  answer: string;
}

/** The longest answer taken: a six-digit code, typed with spaces or not, and room to spare. */
export const NODE_ANSWER_MAX_CHARS = 32;

/** An answer line as the text typed, or why it is not one. Never throws. */
export function parseJoinAnswer(line: string): { ok: true; answer: string } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'That was not an answer: send one line of JSON, like {"answer":"157 640"}.' };
  }
  const answer = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as { answer?: unknown }).answer : undefined;
  if (typeof answer !== 'string') return { ok: false, reason: 'An answer is text: {"answer":"157 640"}.' };
  if (answer.length > NODE_ANSWER_MAX_CHARS) return { ok: false, reason: `An answer is at most ${NODE_ANSWER_MAX_CHARS} characters.` };
  return { ok: true, answer };
}

const isStep = (value: unknown): value is JoinStep => JOIN_STEPS.includes(value as JoinStep);
const isTextKind = (value: unknown): value is JoinTextKind => JOIN_TEXT_KINDS.includes(value as JoinTextKind);

/** The line an event says, or null when it is not one this terminal knows. */
function sayOf(e: Record<string, unknown>): JoinSay | null {
  const has = (key: string): boolean => typeof e[key] === 'string';
  if (isTextKind(e.kind) && has('text')) return { kind: e.kind, text: e.text as string };
  if (e.kind === 'code' && has('code')) return { kind: 'code', code: e.code as string };
  if (e.kind === 'field' && has('label') && has('value') && (e.note === undefined || has('note'))) {
    return { kind: 'field', label: e.label as string, value: e.value as string, ...(e.note === undefined ? {} : { note: e.note as string }) };
  }
  return null;
}

/** An event line as the node sent it, or null when it is not one (the terminal says so and stops). Never throws. */
export function parseJoinEvent(line: string): NodeJoinEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const e = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  if (e.event === 'say' && isStep(e.step)) {
    const said = sayOf(e);
    return said ? { event: 'say', step: e.step, ...said } : null;
  }
  if (e.event === 'ask' && isStep(e.step) && typeof e.prompt === 'string') return { event: 'ask', step: e.step, prompt: e.prompt };
  if (e.event === 'end' && typeof e.ok === 'boolean' && typeof e.text === 'string') {
    return { event: 'end', ok: e.ok, text: e.text, ...(typeof e.next === 'string' ? { next: e.next } : {}) };
  }
  // A refusal before the conversation began (an unknown command, a node still starting) is a plain reply.
  if (e.ok === false && typeof e.reason === 'string') return { event: 'end', ok: false, text: e.reason };
  return null;
}
