// Where a node reads the versions it installs gh and glab at (shared/node-git-tools.ts): the installed bundle's
// `tools.json`, beside its `VERSION`; in a checkout, which has no bundle, the same function the build writes it from.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseToolPins, TOOL_PINS_FILE, toolPinsOf, type ToolPins } from '../shared/node-git-tools.ts';
import { nodeInstallPaths } from '../shared/node-service.ts';

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

/** The pins this node installs. `read` is for tests. */
export function toolPins(home: string, read: (path: string) => string | null = readText): ToolPins {
  return parseToolPins(read(join(nodeInstallPaths(home).current, TOOL_PINS_FILE))) ?? toolPinsOf();
}
