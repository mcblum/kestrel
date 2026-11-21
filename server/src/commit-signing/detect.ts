// How a session's repository signs commits, and where GnuPG keeps its sockets, asked of git and
// gpgconf. Only reads: `git config --get` and `gpgconf --list-dirs` change nothing. A socket is
// offered only if it exists. Anything that fails means no signing access (the outside-the-sandbox
// card still works), never an error.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { signingAccess, type GpgDirs, type SigningAccess, type SigningConfig } from '../shared/commit-signing.ts';

/** Runs a program and answers its standard output, or null when it failed. */
export type Run = (file: string, args: readonly string[], cwd?: string) => Promise<string | null>;

/** How long one question to git or gpgconf may take. */
export const DETECT_TIMEOUT_MS = 3000;

export const runProgram: Run = (file, args, cwd) =>
  new Promise((resolve) => execFile(file, [...args], { cwd, timeout: DETECT_TIMEOUT_MS }, (error, stdout) => resolve(error ? null : stdout)));

const gitValue = async (run: Run, directory: string, args: readonly string[]): Promise<string | null> => (await run('git', ['-C', directory, 'config', ...args], directory))?.trim() || null;

/** The repository's signing settings, as git resolves them (its own config over the global one). */
export async function signingConfig(run: Run, directory: string): Promise<SigningConfig> {
  const [commit, tag, format, signingKey] = await Promise.all([
    gitValue(run, directory, ['--type=bool', '--get', 'commit.gpgsign']),
    gitValue(run, directory, ['--type=bool', '--get', 'tag.gpgsign']),
    gitValue(run, directory, ['--get', 'gpg.format']),
    gitValue(run, directory, ['--get', 'user.signingkey']),
  ]);
  return { signs: commit === 'true' || tag === 'true', format: format ?? 'openpgp', signingKey };
}

/** `gpgconf --list-dirs` read into its folders. Pure. */
export function parseGpgDirs(text: string): GpgDirs {
  const pairs = text.split('\n').flatMap((line) => {
    const at = line.indexOf(':');
    // gpgconf percent-escapes a colon in a path as %3a.
    return at > 0 ? [[line.slice(0, at), decodeURIComponent(line.slice(at + 1).trim())] as const] : [];
  });
  return Object.fromEntries(pairs) as GpgDirs;
}

async function gpgDirs(run: Run, exists: (path: string) => boolean): Promise<GpgDirs | null> {
  const text = await run('gpgconf', ['--list-dirs']);
  if (!text) return null;
  const dirs = parseGpgDirs(text);
  const present = (path: string | undefined) => (path && exists(path) ? path : undefined);
  return { homedir: dirs.homedir, 'agent-socket': present(dirs['agent-socket']), 'keyboxd-socket': present(dirs['keyboxd-socket']) };
}

export interface DetectDeps {
  run: Run;
  exists: (path: string) => boolean;
  home: string;
  sshAuthSock?: string;
}

export const systemDetect = (): DetectDeps => ({ run: runProgram, exists: existsSync, home: homedir(), sshAuthSock: process.env.SSH_AUTH_SOCK });

/** What a sandbox in `directory` must let through for a signed commit there, or null. */
export async function detectSigning(directory: string, deps: DetectDeps): Promise<SigningAccess | null> {
  const config = await signingConfig(deps.run, directory);
  if (!config.signs) return null;
  const gpg = config.format === 'ssh' ? null : await gpgDirs(deps.run, deps.exists);
  const sock = deps.sshAuthSock && deps.exists(deps.sshAuthSock) ? deps.sshAuthSock : undefined;
  return signingAccess(config, gpg, { home: deps.home, ...(sock ? { sshAuthSock: sock } : {}) });
}
