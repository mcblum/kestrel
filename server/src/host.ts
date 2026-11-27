// What differs between the computers Kestrel's server runs on, in one place: which shell is the
// user's, how a script is handed to it, and how a command and everything it started is ended.
// Callers take the platform as an argument so tests can ask about all three from any of them.
import { execFile } from 'node:child_process';
import type { KestrelKind } from './shared/host-kind.ts';
import { platformOf, type Platform } from './shared/platform.ts';

type Env = Record<string, string | undefined>;

export const hostPlatform = (): Platform => platformOf(process.platform);

// Which kind of Kestrel server this is (shared/host-kind.ts), decided once by the entry that started it:
// index.ts is the app's, node.ts a worker node's. Nothing else reads an environment variable for it, and a
// caller that matters takes the kind as an argument (defaulting to this) so tests cover both.
let startedAs: KestrelKind = 'app';

export const hostKind = (): KestrelKind => startedAs;

/** Called by an entry, before it starts the server. */
export function useHostKind(kind: KestrelKind): void {
  startedAs = kind;
}

/** A program and the arguments that start it. */
export interface Launch {
  file: string;
  args: string[];
}

/** When SHELL names none: the system's default shell. */
const UNIX_FALLBACK: Record<Exclude<Platform, 'windows'>, string> = { mac: '/bin/zsh', linux: '/bin/bash' };

/**
 * The shell a terminal opens: the user's own login shell on macOS and Linux (`$SHELL -l`), and on
 * Windows PowerShell, which is on every supported Windows (`KESTREL_WINDOWS_SHELL` names another,
 * for someone who wants pwsh or Git Bash). Windows has no login shell and no SHELL variable.
 */
export function terminalShell(env: Env, platform: Platform = hostPlatform()): Launch {
  if (platform === 'windows') return { file: env.KESTREL_WINDOWS_SHELL || 'powershell.exe', args: [] };
  return { file: env.SHELL || UNIX_FALLBACK[platform], args: ['-l'] };
}

/**
 * How a script (a project's setup, run or archive script) is run: by the user's login shell on
 * macOS and Linux, as a terminal would run it; on Windows by cmd.exe, the shell every Windows
 * script written for a `scripts` field already assumes. The script is one argument, never spliced
 * into a command line here; on Windows `verbatim` asks Node not to re-quote it, since cmd.exe
 * reads everything after /c as the command.
 */
export function scriptShell(env: Env, script: string, platform: Platform = hostPlatform()): Launch & { verbatim: boolean } {
  if (platform === 'windows') return { file: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${script}"`], verbatim: true };
  return { file: env.SHELL || UNIX_FALLBACK[platform], args: ['-l', '-c', script], verbatim: false };
}

/** Runs a program to its end; never rejects. For the short system tools below. */
export type RunTool = (file: string, args: readonly string[]) => Promise<void>;
const runTool: RunTool = (file, args) => new Promise((resolve) => execFile(file, [...args], { timeout: 10_000, windowsHide: true }, () => resolve()));

/**
 * Ends a command started in a group of its own (`detached: true`) and everything it started.
 * macOS and Linux: the signal goes to the process group. Windows has no process groups or
 * signals: `taskkill /T` ends the tree, and only `/F` (force) ends a program that has no window
 * to be asked, so both the polite and the final request are forced there.
 */
export function endTree(pid: number, signal: 'SIGTERM' | 'SIGKILL', platform: Platform = hostPlatform(), run: RunTool = runTool, kill: (pid: number, signal: NodeJS.Signals) => void = process.kill.bind(process)): void {
  if (platform === 'windows') return void run('taskkill', ['/pid', String(pid), '/T', '/F']);
  try {
    kill(-pid, signal);
  } catch {
    // already gone
  }
}
