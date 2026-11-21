// The per-thread configuration Kestrel gives Codex (`thread/start`'s `config`): dotted config keys
// that override ~/.codex/config.toml for this thread only. Nothing is ever written to that file.
// Pure; the caller passes in the server names config.toml defines (quiet.ts reads them).
//
// - Kestrel's tools: an MCP server over streamable HTTP, served by Kestrel itself for this one
//   session (kestrel-mcp/). Codex reads the bearer token from its own environment
//   (`bearer_token_env_var`), so the token is in no config value, file or log.
// - The user's MCP servers: only the ones switched on for the project, translated from the shape
//   discovered in shared/setup.ts; every other server in config.toml is switched off for the thread.
// - Codex plugins and apps (connectors to outside services) are off, as claude.ai connectors are
//   for Claude, and so is the user's `notify` hook.
import type { Json } from './rpc.ts';
import type { StartOptions } from '../types.ts';

export const KESTREL_SERVER = 'kestrel';
/** The variable Codex reads the Kestrel MCP token from. Codex keeps variables named *TOKEN* out of the commands it runs. */
export const MCP_TOKEN_ENV = 'KESTREL_MCP_TOKEN';
/** Kestrel's own approval cards (delegate, spawn) wait for the user inside a tool call: Codex's 60 s default would cut them off. */
const KESTREL_TOOL_TIMEOUT_SEC = 24 * 60 * 60;
/** A server name Codex takes in a dotted config path as it is. */
const PLAIN_NAME = /^[A-Za-z0-9_-]+$/;

type Setup = StartOptions['setup'];

/** One discovered server (shared/setup.ts shape) as Codex's `mcp_servers.<name>` table; null when it cannot be expressed. */
export function codexServerConfig(config: Record<string, unknown>): Record<string, Json> | null {
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const table = (v: unknown): Record<string, string> | undefined => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
    const entries = Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string');
    return entries.length ? Object.fromEntries(entries) : undefined;
  };
  if (typeof config.url === 'string') {
    // Codex speaks streamable HTTP; an SSE-only server is not something it can reach.
    if (config.type === 'sse') return null;
    const headers = table(config.headers);
    return { url: config.url, ...(headers ? { http_headers: headers } : {}) };
  }
  if (typeof config.command !== 'string') return null;
  const env = table(config.env);
  return { command: config.command, args: strings(config.args), ...(env ? { env } : {}) };
}

export interface ThreadConfigInput {
  /** Where this session's Kestrel tools are served. Null: the session has none (tests, or no server). */
  kestrelUrl: string | null;
  setup: Setup;
  /** MCP server names defined in the user's config.toml. */
  configuredServers: readonly string[];
}

export function threadConfig({ kestrelUrl, setup, configuredServers }: ThreadConfigInput): Record<string, Json> {
  const config: Record<string, Json> = {
    'features.plugins': false,
    'features.apps': false,
    notify: [],
    'sandbox_workspace_write.network_access': true,
  };
  const enabled = new Set<string>();
  for (const [name, server] of Object.entries(setup?.mcpServers ?? {})) {
    if (name === KESTREL_SERVER || !PLAIN_NAME.test(name)) continue;
    const table = codexServerConfig(server);
    if (!table) continue;
    config[`mcp_servers.${name}`] = table;
    enabled.add(name);
  }
  for (const name of configuredServers) {
    if (name !== KESTREL_SERVER && !enabled.has(name) && PLAIN_NAME.test(name)) config[`mcp_servers.${name}.enabled`] = false;
  }
  if (kestrelUrl) config[`mcp_servers.${KESTREL_SERVER}`] = { url: kestrelUrl, bearer_token_env_var: MCP_TOKEN_ENV, tool_timeout_sec: KESTREL_TOOL_TIMEOUT_SEC };
  // Without the user's settings, the project's AGENTS.md is not read either (their CLAUDE.md is not, for Claude).
  if (setup && !setup.loadSettings) config.project_doc_max_bytes = 0;
  return config;
}

/**
 * The standing instruction as Codex should read it. Codex names MCP tools to its model exactly as
 * Claude does (`mcp__kestrel__handoff`, checked on codex-cli 0.167.2), so only the line about
 * Claude's ToolSearch step changes.
 */
export function codexInstruction(text: string): string {
  return text.replace(/load it with ToolSearch first/g, 'look it up with your tool search first');
}
