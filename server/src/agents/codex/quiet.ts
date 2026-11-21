// A title run needs no tools, but `codex exec` starts every MCP server the user configured (and
// those their plugins bring) before it answers, which made one title take 6.6 s. These arguments
// switch them off for that one run, leaving the user's model, provider and sign-in alone.
//
// Checked against codex-cli 0.167: `-c mcp_servers={}` does not do it (overrides merge into the
// table, so every server is still there), and `--ignore-user-config` would also drop the user's
// model and provider. What works is `--disable plugins` (the servers plugins bring) plus
// `mcp_servers.<name>.enabled=false` for each server named in config.toml. A name that is not
// defined there must not be overridden (codex then refuses to start), so only names found in the
// file are used.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type Env = Record<string, string | undefined>;

/** A server name codex takes in a dotted `-c` path as it is. Others (quoted, dotted) are left running. */
const PLAIN_NAME = /^[A-Za-z0-9_-]+$/;

/** The MCP servers a codex config.toml defines: its `[mcp_servers.<name>]` tables (not their sub-tables). */
export function mcpServerNames(toml: string): string[] {
  const names = new Set<string>();
  for (const line of toml.split('\n')) {
    const match = /^\s*\[\s*mcp_servers\.([^\]]+?)\s*\]\s*(#.*)?$/.exec(line);
    const name = match?.[1];
    if (name && PLAIN_NAME.test(name)) names.add(name);
  }
  return [...names];
}

/** The `codex exec` arguments that start no MCP servers and run no notify hook. */
export function quietArgs(servers: readonly string[]): string[] {
  return ['--disable', 'plugins', '-c', 'notify=[]', ...servers.flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`])];
}

/** The user's codex config.toml, or null when there is none. */
export function readCodexConfig(env: Env = process.env): string | null {
  const home = env.CODEX_HOME || join(env.HOME || homedir(), '.codex');
  try {
    return readFileSync(join(home, 'config.toml'), 'utf8');
  } catch {
    return null;
  }
}
