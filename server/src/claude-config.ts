// Reads every MCP server the user has set up on this Mac, whichever agent or app it was set up
// for: Claude Code, the Claude desktop app, Codex and OpenCode. Nothing is written. A file that
// is missing or unreadable simply contributes no servers.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { stripJsonc } from './agents/opencode/user-config.ts';
import { discoverMcpServers, type DiscoveredServer } from './shared/setup.ts';

function read<T>(path: string, parse: (text: string) => T): T | null {
  try {
    return parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
const json = (path: string) => read(path, (text) => JSON.parse(text) as unknown);

/** Servers a project's sessions could use; with no project, the ones not tied to a project. */
export function userMcpServers(projectPath: string | null, home: string = homedir()): DiscoveredServer[] {
  return discoverMcpServers(projectPath, {
    claude: json(join(home, '.claude.json')),
    projectFile: projectPath ? json(join(projectPath, '.mcp.json')) : null,
    // macOS path; on another system it is simply not found.
    desktop: json(join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')),
    codex: read(join(home, '.codex', 'config.toml'), (text) => parseToml(text) as unknown),
    opencode: ['opencode.json', 'opencode.jsonc'].map((f) => read(join(home, '.config', 'opencode', f), (text) => JSON.parse(stripJsonc(text)) as unknown)).find(Boolean) ?? null,
  });
}
