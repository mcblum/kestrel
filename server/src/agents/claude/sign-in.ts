// Whether Claude is signed in, and signing it in from Kestrel. Kestrel ships the Claude Code
// program its Claude sessions run on, so somebody who has only the Claude desktop app has no
// `claude` command to sign in with, and the desktop app's sign-in is not shared with it. The
// shipped program can do both itself: `auth status` answers without running a turn, and
// `auth login` opens the sign-in page in the browser.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { hostPlatform } from '../../host.ts';
import type { Platform } from '../../shared/platform.ts';
import { findIn, installDirs } from '../find-program.ts';
import { cliSignIn, type AgentSignIn } from '../sign-in.ts';
import { claudeEnv } from './env.ts';
import { CLAUDE_EXECUTABLE_ENV } from './executable.ts';

type Env = Record<string, string | undefined>;
type Exists = (path: string) => boolean;

const STATUS_TIMEOUT_MS = 10_000;
const SDK = '@anthropic-ai/claude-agent-sdk';
const SDK_OS: Record<Platform, string> = { mac: 'darwin', windows: 'win32', linux: 'linux' };

/** The folder of the SDK's own program for this computer, or null. From a checkout only: the packaged app names its copy. */
function sdkProgramDir(platform: Platform, arch: string): string | null {
  try {
    const fromSdk = createRequire(import.meta.resolve(SDK));
    const names = [`${SDK}-${SDK_OS[platform]}-${arch}`, ...(platform === 'linux' ? [`${SDK}-linux-${arch}-musl`] : [])];
    for (const name of names) {
      try {
        return dirname(fromSdk.resolve(`${name}/package.json`));
      } catch {
        // not this one
      }
    }
  } catch {
    // no SDK to ask
  }
  return null;
}

/** The Claude Code program Kestrel's sessions run on: the one the app ships, else the SDK's own. Null when neither is there. */
export function claudeProgram(env: Env = process.env, platform: Platform = hostPlatform(), arch: string = process.arch, exists: Exists = existsSync, sdkDir: (platform: Platform, arch: string) => string | null = sdkProgramDir): string | null {
  const shipped = env[CLAUDE_EXECUTABLE_ENV];
  if (shipped) return exists(shipped) ? shipped : null;
  const dir = sdkDir(platform, arch);
  const found = dir ? join(dir, platform === 'windows' ? 'claude.exe' : 'claude') : null;
  return found && exists(found) ? found : null;
}

/**
 * What `claude auth status` said, as signed in or not. Null when it cannot be told: the answer
 * could not be read, or Claude is set up to reach a provider other than Anthropic, where there is
 * no sign-in to ask about. Pure.
 */
export function signedInFromStatus(stdout: string): boolean | null {
  let status: unknown;
  try {
    status = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof status !== 'object' || status === null) return null;
  const { loggedIn, apiProvider } = status as { loggedIn?: unknown; apiProvider?: unknown };
  if (loggedIn === true) return true;
  if (loggedIn === false && (apiProvider === undefined || apiProvider === 'firstParty')) return false;
  return null;
}

export type RunStatus = (program: string, env: Env) => Promise<string>;

const runStatus: RunStatus = (program, env) =>
  new Promise((resolve) => {
    // A signed-out Claude may answer with a failing exit code: what it printed is read either way.
    execFile(program, ['auth', 'status', '--json'], { env: env as NodeJS.ProcessEnv, timeout: STATUS_TIMEOUT_MS, windowsHide: true }, (_error, stdout) => resolve(String(stdout)));
  });

/** Whether Claude is signed in, asked of the program without running a turn. Null when it cannot be told. */
export async function claudeSignedIn(env: Env = process.env, program: string | null = claudeProgram(env), run: RunStatus = runStatus): Promise<boolean | null> {
  if (!program) return null;
  return signedInFromStatus(await run(program, claudeEnv(env)));
}

/** What of Claude's is on this computer besides the program Kestrel ships. */
export interface ClaudeInstalled {
  /** The Claude desktop app. */
  desktop: boolean;
  /** A `claude` command of the user's own. */
  cli: boolean;
}

/** Where the Claude desktop app is installed on each kind of computer. */
function desktopPaths(platform: Platform, home: string, env: Env): string[] {
  if (platform === 'mac') return ['/Applications/Claude.app', join(home, 'Applications', 'Claude.app')];
  if (platform === 'windows') return env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'AnthropicClaude')] : [];
  return [];
}

export function claudeInstalled(env: Env = process.env, platform: Platform = hostPlatform(), exists: Exists = existsSync, home: string = homedir()): ClaudeInstalled {
  const dirs = [...(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean), ...installDirs(home, platform, env)];
  return { desktop: desktopPaths(platform, home, env).some(exists), cli: findIn(dirs, 'claude', platform, exists) !== null };
}

/** Why Claude cannot start when it is not signed in, and what to do, worded for what this computer has. Pure. */
export function claudeSignInAdvice(installed: ClaudeInstalled): string {
  if (installed.desktop && !installed.cli) return 'Claude is not signed in. Signing in to the Claude desktop app does not sign Kestrel in: choose Sign in to use the same account here.';
  return 'Claude is not signed in: choose Sign in, or run `claude` in a terminal and sign in with /login.';
}

/** Signing Claude in with the program Kestrel runs it on. */
export function claudeSignIn(env: Env = process.env): AgentSignIn {
  return cliSignIn({
    command: () => {
      const program = claudeProgram(env);
      return program ? { file: program, args: ['auth', 'login'], env: claudeEnv(env) } : null;
    },
    missing: 'Kestrel could not find the Claude Code program to sign in with. Reinstall Kestrel, or from a checkout run `pnpm install`.',
  });
}
