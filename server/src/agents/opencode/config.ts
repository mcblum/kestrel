// The configuration Kestrel gives one `opencode serve` process (OPENCODE_CONFIG_CONTENT). OpenCode
// merges it over the user's own files (~/.config/opencode, the project's opencode.json) for that
// process only; nothing is ever written to them. Pure; the caller reads the server names the
// user's files define (user-config.ts) and writes the instruction file (instruction.ts).
//
// - Kestrel's tools: an MCP server over streamable HTTP, served by Kestrel for this one session
//   (kestrel-mcp.ts), with the session's token in an Authorization header. OpenCode names its
//   tools `kestrel_<tool>`.
// - The user's MCP servers: only the ones switched on for the project (shared/setup.ts); every
//   other server their OpenCode files define is switched off for this process.
// - Permissions: every tool that changes something, and every tool Kestrel does not know, asks.
//   Kestrel answers each ask itself by the session's level (decide.ts), so the edit rule sees every
//   edit before it is made, in every level. Reads, searches, the todo list, skills, questions and
//   Kestrel's own tools do not ask. Rules here are appended after OpenCode's defaults, so they win
//   (checked on opencode 1.14.25: `app.agents` lists them last).
// - The standing instruction: a file OpenCode adds to every agent's system prompt (`instructions`).
// - Sharing and self-update are off.
import { BROWSER_ACTIONS, SIM_ACTIONS } from '../claude/options.ts';
import type { StartOptions } from '../types.ts';

export const KESTREL_SERVER = 'kestrel';
/** How OpenCode names an MCP server's tool to the model and in permissions. */
export const opencodeToolName = (server: string, tool: string): string => `${server}_${tool}`;

/** Kestrel's tools that act on something (browser clicks, simulator taps), in OpenCode's names: they ask, as for Claude. */
export const ACTING_KESTREL_TOOLS: readonly string[] = [...BROWSER_ACTIONS, ...SIM_ACTIONS].map((t) => opencodeToolName(KESTREL_SERVER, t.replace(/^mcp__kestrel__/, '')));

/** What asks and what does not, in every level (decide.ts answers the asks). Later rules win. */
export const BASE_PERMISSION: Readonly<Record<string, 'ask' | 'allow'>> = {
  '*': 'ask',
  read: 'allow',
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  lsp: 'allow',
  todowrite: 'allow',
  todoread: 'allow',
  skill: 'allow',
  question: 'allow',
  task: 'allow',
  [opencodeToolName(KESTREL_SERVER, '*')]: 'allow',
  ...Object.fromEntries(ACTING_KESTREL_TOOLS.map((t) => [t, 'ask'])),
};

/** Kestrel's tool calls wait for the user (delegate's approval card, say): OpenCode's default MCP timeout would cut them off. */
const KESTREL_TOOL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

type Setup = StartOptions['setup'];
type McpEntry = Record<string, unknown>;

/** One discovered server (shared/setup.ts shape, Claude's words) in OpenCode's words; null when it cannot be expressed. */
export function opencodeServerConfig(config: Record<string, unknown>): McpEntry | null {
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const table = (v: unknown): Record<string, string> | undefined => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
    const entries = Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string');
    return entries.length ? Object.fromEntries(entries) : undefined;
  };
  if (typeof config.url === 'string') {
    const headers = table(config.headers);
    return { type: 'remote', url: config.url, enabled: true, ...(headers ? { headers } : {}) };
  }
  if (typeof config.command !== 'string') return null;
  const environment = table(config.env);
  return { type: 'local', command: [config.command, ...strings(config.args)], enabled: true, ...(environment ? { environment } : {}) };
}

export interface ProcessConfigInput {
  /** Where this session's Kestrel tools are served, and its token. Null: the session has none. */
  kestrel: { url: string; token: string } | null;
  setup: Setup;
  /** MCP server names the user's OpenCode files define (global and the project's). */
  configuredServers: readonly string[];
  /** The file holding the standing instruction. */
  instructionFile: string;
  /** The model the session runs, `provider/model`; absent leaves the user's default. */
  model?: string;
}

function mcpServers(input: ProcessConfigInput): Record<string, McpEntry> {
  const out: Record<string, McpEntry> = {};
  for (const [name, server] of Object.entries(input.setup?.mcpServers ?? {})) {
    const entry = name === KESTREL_SERVER ? null : opencodeServerConfig(server);
    if (entry) out[name] = entry;
  }
  for (const name of input.configuredServers) if (name !== KESTREL_SERVER && !out[name]) out[name] = { enabled: false };
  if (input.kestrel) out[KESTREL_SERVER] = { type: 'remote', url: input.kestrel.url, enabled: true, oauth: false, headers: { Authorization: `Bearer ${input.kestrel.token}` }, timeout: KESTREL_TOOL_TIMEOUT_MS };
  return out;
}

export function processConfig(input: ProcessConfigInput): Record<string, unknown> {
  return {
    autoupdate: false,
    share: 'disabled',
    permission: { ...BASE_PERMISSION },
    mcp: mcpServers(input),
    instructions: [input.instructionFile],
    ...(input.model ? { model: input.model } : {}),
  };
}

/**
 * Environment switches for a session that does not load the user's setup (Settings → a project's
 * agent setup, "Load my instructions and skills" off): no project opencode.json, no Claude Code
 * files (CLAUDE.md, ~/.claude/skills) and no skills from outside OpenCode's own folders.
 */
export function isolationEnv(setup: Setup): Record<string, string> {
  if (!setup || setup.loadSettings) return {};
  return { OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1' };
}

/** Kestrel's standing instruction names tools as Claude does (`mcp__kestrel__handoff`); OpenCode calls them `kestrel_handoff`, and has no ToolSearch step. */
export function opencodeInstruction(text: string): string {
  return opencodeToolNames(text)
    .replace(/The browser and simulator tools may not have their schema loaded yet: for one of those, load it with ToolSearch first, then call it\. The rest are ready to call:/g, 'All of them are ready to call:')
    .replace(/load it with ToolSearch first/g, 'call it directly');
}

/** Any Kestrel tool name in Claude's spelling, in OpenCode's (refusal reasons name tools too). */
export const opencodeToolNames = (text: string): string => text.replace(/mcp__kestrel__([a-z_]+)/g, (_m, tool: string) => opencodeToolName(KESTREL_SERVER, tool));
