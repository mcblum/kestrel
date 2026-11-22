// Finding the `codex` command. An app opened from the Dock gets a minimal PATH (no Homebrew, no
// nvm), so PATH alone is not enough: the usual install folders are looked in too, newest nvm Node
// first. Null when it is not installed anywhere we know.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { hostPlatform } from '../../host.ts';
import type { Platform } from '../../shared/platform.ts';
import { findIn, installDirs } from '../find-program.ts';

type Env = Record<string, string | undefined>;

export interface Lookup {
  exists(path: string): boolean;
  list(dir: string): string[];
  home: string;
}

const listOrEmpty = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

export const realLookup: Lookup = { exists: existsSync, list: listOrEmpty, home: homedir() };

const newestFirst = (a: string, b: string): number => b.localeCompare(a, undefined, { numeric: true });

/** Install folders a GUI-launched app may not have on its PATH (find-program.ts), then each nvm Node's, newest first. */
function wellKnownDirs(lookup: Lookup, platform: Platform, env: Env): string[] {
  const nvm = join(lookup.home, '.nvm', 'versions', 'node');
  const nodeBins = platform === 'windows' ? [] : [...lookup.list(nvm)].sort(newestFirst).map((v) => join(nvm, v, 'bin'));
  return [...installDirs(lookup.home, platform, env), ...nodeBins];
}

/** The path of the `codex` command, from PATH first and then the usual install folders. */
export function findCodex(env: Env = process.env, lookup: Lookup = realLookup, platform: Platform = hostPlatform()): string | null {
  const dirs = [...(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean), ...wellKnownDirs(lookup, platform, env)];
  return findIn(dirs, 'codex', platform, lookup.exists);
}

/**
 * The environment to run `codex` with: the npm package is a `#!/usr/bin/env node` script, so the
 * folder it was found in (where its Node lives too, for nvm) goes first on PATH.
 */
export function codexEnv(env: Env, binary: string): Env {
  const path = [dirname(binary), ...(env.PATH ?? '').split(delimiter).filter(Boolean)].join(delimiter);
  return { ...env, PATH: path };
}
