// Finding the `opencode` command. OpenCode's own installer puts it in ~/.opencode/bin, which is on
// the PATH of a login shell only; an app opened from the Dock gets a minimal PATH, so the usual
// install folders are looked in too (Homebrew, npm, bun). Null when it is not installed anywhere
// Kestrel knows. `KESTREL_OPENCODE_BINARY` overrides the lookup (tests and support).
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

type Env = Record<string, string | undefined>;

export interface Lookup {
  exists(path: string): boolean;
  home: string;
}

const existsSafe = (path: string): boolean => {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
};

export const realLookup: Lookup = { exists: existsSafe, home: homedir() };

/** Install folders a GUI-launched app may not have on its PATH, OpenCode's own first. */
function wellKnownDirs(home: string): string[] {
  return [join(home, '.opencode', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', join(home, '.local', 'bin'), join(home, '.bun', 'bin'), join(home, '.npm-global', 'bin'), join(home, '.volta', 'bin')];
}

/** The `opencode` to run: the override when set (null if it does not exist), else PATH, else the usual folders. */
export function findOpencode(env: Env = process.env, lookup: Lookup = realLookup): string | null {
  const override = env.KESTREL_OPENCODE_BINARY;
  if (override !== undefined && override !== '') return lookup.exists(override) ? override : null;
  const dirs = [...(env.PATH ?? '').split(delimiter).filter(Boolean), ...wellKnownDirs(lookup.home)];
  for (const dir of dirs) {
    const candidate = join(dir, 'opencode');
    if (lookup.exists(candidate)) return candidate;
  }
  return null;
}
