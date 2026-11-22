// Finding an agent's command-line program (`codex`, `opencode`) on each kind of computer, and how
// to start what was found. An app opened from the Dock or a desktop launcher can have a short
// PATH, so the usual install folders are looked in after it.
//
// Windows: a program installed with npm is `<name>.cmd` (a script that starts Node), a native one
// `<name>.exe`; both are looked for. Node will not start a .cmd directly (it refuses, since a batch
// file is run by cmd.exe and its arguments are not safely quotable in general), so one is started
// through the shell with its path quoted. Kestrel's own arguments to these programs are fixed
// words and numbers, never text from a conversation.
import { join } from 'node:path';
import type { Platform } from '../shared/platform.ts';

type Env = Record<string, string | undefined>;

/** The file names a command may have. */
export function programNames(name: string, platform: Platform): string[] {
  return platform === 'windows' ? [`${name}.exe`, `${name}.cmd`] : [name];
}

/** Install folders an app may not have on its PATH, for tools installed with npm, bun, Volta or Homebrew. */
export function installDirs(home: string, platform: Platform, env: Env = {}): string[] {
  const own = [join(home, '.local', 'bin'), join(home, '.volta', 'bin'), join(home, '.bun', 'bin'), join(home, '.npm-global', 'bin')];
  if (platform === 'mac') return ['/opt/homebrew/bin', '/usr/local/bin', ...own];
  if (platform === 'linux') return ['/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin', '/snap/bin', ...own];
  // npm's global folder on Windows, then the same tools' own folders.
  return [...(env.APPDATA ? [join(env.APPDATA, 'npm')] : []), ...own];
}

/** The first of `dirs` that holds the program, under any of its names. */
export function findIn(dirs: readonly string[], name: string, platform: Platform, exists: (path: string) => boolean): string | null {
  for (const dir of dirs) {
    for (const file of programNames(name, platform)) {
      const candidate = join(dir, file);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/** What to hand `spawn` to start a found program: itself, or on Windows a .cmd through the shell. */
export function spawnTarget(command: string, platform: Platform): { command: string; shell: boolean } {
  const batch = platform === 'windows' && /\.(cmd|bat)$/i.test(command);
  return batch ? { command: `"${command}"`, shell: true } : { command, shell: false };
}
