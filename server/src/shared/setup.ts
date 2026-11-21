// What of the user's own Claude Code setup a session gets. Pure.
//
// Their instructions, skills, commands and hooks load by default: that is what makes a Kestrel
// session behave like the same prompt in Claude Code. MCP servers are different. They can
// reach outside services, so each one stays off until the user switches it on for a project.

export interface ProjectSetup {
  /** Load CLAUDE.md, skills, slash commands and hooks from the user's and the project's settings. */
  loadSettings: boolean;
  /** Names of the user's MCP servers this project's sessions may use. */
  mcpServers: string[];
}

export const DEFAULT_SETUP: ProjectSetup = { loadSettings: true, mcpServers: [] };

export function sanitizeSetup(value: unknown): ProjectSetup {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const names = Array.isArray(v.mcpServers) ? [...new Set(v.mcpServers.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 200))] : [];
  return { loadSettings: v.loadSettings !== false, mcpServers: names };
}

/**
 * Where a server is configured. Claude Code's own scopes come first (this project only, the
 * project's shared file, every project); then the other agents' and apps' configs, which Kestrel
 * reads so one list covers everything the user has set up.
 */
export type McpScope = 'local' | 'project' | 'user' | 'codex' | 'opencode' | 'desktop';

export interface McpServerInfo {
  name: string;
  scope: McpScope;
  kind: 'stdio' | 'http' | 'sse';
  /** What it runs or where it connects, without arguments, headers or environment (those can hold secrets). */
  where: string;
}

/** A server's configuration in the shape the Claude Agent SDK takes. Passed to the agent; never sent to the UI. */
export type McpConfig = Record<string, unknown>;

export interface DiscoveredServer extends McpServerInfo {
  config: McpConfig;
}

type Json = Record<string, unknown>;
const record = (v: unknown): Json => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {});
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function describe(name: string, scope: McpScope, raw: unknown): DiscoveredServer | null {
  const config = record(raw);
  if (typeof config.url === 'string') {
    let where = 'a remote server';
    try {
      where = new URL(config.url).host;
    } catch {
      // Not a URL we can read; say only that it is remote.
    }
    const kind = config.type === 'sse' ? 'sse' : 'http';
    return { name, scope, kind, where, config: { ...config, type: kind } };
  }
  if (typeof config.command === 'string') return { name, scope, kind: 'stdio', where: config.command.split('/').pop() || config.command, config };
  return null;
}

/** OpenCode writes a local server's command as one array and calls the environment `environment`. */
function fromOpenCode(raw: unknown): unknown {
  const c = record(raw);
  if (c.enabled === false) return null;
  if (c.type === 'remote') return typeof c.url === 'string' ? { type: 'http', url: c.url, ...(c.headers ? { headers: c.headers } : {}) } : null;
  const [command, ...args] = strings(c.command);
  return command ? { command, args, ...(c.environment ? { env: c.environment } : {}) } : null;
}

/** Codex uses the same words as Claude Code for a local server; a remote one is just a `url`. */
function fromCodex(raw: unknown): unknown {
  const c = record(raw);
  if (c.enabled === false) return null;
  if (typeof c.url === 'string') return { type: 'http', url: c.url, ...(c.http_headers ? { headers: c.http_headers } : {}) };
  return typeof c.command === 'string' ? { command: c.command, args: strings(c.args), ...(c.env ? { env: c.env } : {}) } : null;
}

/** The parsed config files MCP servers are read from. Any of them may be missing. */
export interface McpSources {
  /** `~/.claude.json`: servers for every project, and per-project ones under `projects[path]`. */
  claude?: unknown;
  /** The project's `.mcp.json`. */
  projectFile?: unknown;
  /** The Claude desktop app's `claude_desktop_config.json`. */
  desktop?: unknown;
  /** `~/.codex/config.toml`, parsed. */
  codex?: unknown;
  /** OpenCode's global config (`~/.config/opencode/opencode.json` or `.jsonc`), parsed. */
  opencode?: unknown;
}

/**
 * Every MCP server the user has set up that a project could use, whichever agent or app it was
 * set up for. A name defined more than once resolves to Claude Code's narrowest scope first,
 * then Claude Code's user scope, then the other tools.
 */
export function discoverMcpServers(projectPath: string | null, sources: McpSources): DiscoveredServer[] {
  const claude = record(sources.claude);
  const found = new Map<string, DiscoveredServer>();
  const add = (scope: McpScope, servers: unknown, convert: (raw: unknown) => unknown = (raw) => raw) => {
    for (const [name, raw] of Object.entries(record(servers))) {
      const server = describe(name, scope, convert(raw));
      if (server) found.set(name, server);
    }
  };
  // Widest first: a later, narrower definition of the same name replaces an earlier one.
  add('desktop', record(sources.desktop).mcpServers);
  add('opencode', record(sources.opencode).mcp, fromOpenCode);
  add('codex', record(sources.codex).mcp_servers, fromCodex);
  add('user', claude.mcpServers);
  if (projectPath) {
    add('project', record(sources.projectFile).mcpServers);
    add('local', record(record(claude.projects)[projectPath]).mcpServers);
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The servers a session starts with: the ones switched on that still exist. */
export function enabledServers(setup: ProjectSetup, discovered: readonly DiscoveredServer[]): Record<string, McpConfig> {
  return Object.fromEntries(discovered.filter((s) => setup.mcpServers.includes(s.name)).map((s) => [s.name, s.config]));
}

/** What the UI may know about a server: never its arguments, headers or environment. */
export const publicInfo = ({ name, scope, kind, where }: DiscoveredServer): McpServerInfo => ({ name, scope, kind, where });
