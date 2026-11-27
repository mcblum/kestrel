// Finding the `opencode` command. OpenCode's own installer puts it in ~/.opencode/bin, which is on
// the PATH of a login shell only; an app opened from the Dock gets a minimal PATH, so the usual
// install folders are looked in too (Homebrew, npm, bun). Null when it is not installed anywhere
// Kestrel knows. `KESTREL_OPENCODE_BINARY` overrides the lookup (tests and support).
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { hostPlatform } from '../../host.ts';
import type { Platform } from '../../shared/platform.ts';
import { findIn, installDirs } from '../find-program.ts';
import { kestrelAgentDirs } from '../kestrel-agents.ts';

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

/** Install folders a GUI-launched app may not have on its PATH (find-program.ts), OpenCode's own first. */
function wellKnownDirs(home: string, platform: Platform, env: Env): string[] {
  return [join(home, '.opencode', 'bin'), ...installDirs(home, platform, env)];
}

/**
 * The `opencode` to run: the override when set (null if it does not exist), else on a worker node Kestrel's own
 * agents folder (`kestrelDirs`), else PATH, else the usual folders.
 */
export function findOpencode(env: Env = process.env, lookup: Lookup = realLookup, platform: Platform = hostPlatform(), kestrelDirs: readonly string[] = kestrelAgentDirs()): string | null {
  const override = env.KESTREL_OPENCODE_BINARY;
  if (override !== undefined && override !== '') return lookup.exists(override) ? override : null;
  const dirs = [...kestrelDirs, ...(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean), ...wellKnownDirs(lookup.home, platform, env)];
  return findIn(dirs, 'opencode', platform, lookup.exists);
}
