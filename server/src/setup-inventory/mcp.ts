// The MCP servers this machine has, for the set-up record: every server found for no project, and the
// ones tied to each registered project's folder. Read through today's discovery (`claude-config.ts`).
// When Kestrel keeps its own list of MCP servers (docs/designs/mcp-servers.md, stage 1, being built
// apart), this reads that list through the one function it exports instead; nothing else here changes.
import { userMcpServers } from '../claude-config.ts';
import type { DiscoveredServer } from '../shared/setup.ts';

export function knownMcpServers(projectPaths: readonly string[], home: string, discover: typeof userMcpServers = userMcpServers): DiscoveredServer[] {
  const found = new Map<string, DiscoveredServer>();
  const add = (server: DiscoveredServer) => found.set(`${server.scope}\n${server.name}`, server);
  for (const server of discover(null, home)) add(server);
  for (const path of projectPaths) for (const server of discover(path, home)) if (server.scope === 'local' || server.scope === 'project') add(server);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope));
}
