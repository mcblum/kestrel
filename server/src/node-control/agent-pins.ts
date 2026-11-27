// Where a node reads the versions it installs Codex and OpenCode at (shared/node-agent-versions.ts): the installed
// bundle's `agents.json`, beside its `VERSION`; in a checkout, which has no bundle, worked out from the server's own
// package.json the same way the build does. Never the network.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentPinsOf, AGENT_PINS_FILE, parseAgentPins, type AgentPins } from '../shared/node-agent-versions.ts';
import { nodeInstallPaths } from '../shared/node-service.ts';

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

/** The pins this node installs. `read` and `checkoutPackage` are for tests. */
export function agentPins(home: string, read: (path: string) => string | null = readText, checkoutPackage: () => string | null = () => readText(new URL('../../package.json', import.meta.url).pathname)): AgentPins {
  const bundled = parseAgentPins(read(join(nodeInstallPaths(home).current, AGENT_PINS_FILE)));
  if (bundled) return bundled;
  const text = checkoutPackage();
  if (!text) throw new Error(`This kestrel-node has no ${AGENT_PINS_FILE} in its bundle. Install the node again.`);
  return agentPinsOf(JSON.parse(text) as { dependencies?: Record<string, string> });
}
