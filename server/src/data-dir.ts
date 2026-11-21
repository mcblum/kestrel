// Where Kestrel keeps its database, launch file, worktrees and scratch folder.
//
// An installed app uses `~/.kestrel`. Anything run from a checkout (`pnpm dev:app`,
// `pnpm dev:server`) uses `~/.kestrel-dev`, so a development build never opens the store a
// real install is using. `KESTREL_DATA_DIR` overrides both.
import { homedir } from 'node:os';
import { join } from 'node:path';

export const INSTALLED_DIR = '.kestrel';
export const DEV_DIR = '.kestrel-dev';

export function dataDir(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  if (env.KESTREL_DATA_DIR) return env.KESTREL_DATA_DIR;
  // The packaged app sets this; nothing run from source does.
  return join(home, env.KESTREL_PACKAGED === '1' ? INSTALLED_DIR : DEV_DIR);
}
