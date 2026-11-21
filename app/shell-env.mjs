// The user's login-shell environment, for an app opened from Finder or the Dock.
//
// Such an app gets launchd's minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), so git, gh, claude,
// codex, node and everything Homebrew, nvm or the user's dotfiles put on PATH would be missing
// for the server and every agent, terminal and tool it starts. So, once at startup, the user's
// own shell is run as a login, interactive shell and asked to print its environment; that is
// used for the server and everything under it.
//
// It must never stop the app from opening: the shell gets a timeout, its stdin is closed, and if
// anything goes wrong the app keeps its own environment with the usual install folders added to
// PATH.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

const SHELL_TIMEOUT_MS = 8000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const FALLBACK_SHELL = '/bin/zsh';
/** Printed around the environment so whatever the user's rc files print is ignored. */
const MARK = '__KESTREL_ENV_7f3a__';
/** Shell variables that describe that shell process, not the user's setup. */
const DROP = new Set(['_', 'PWD', 'OLDPWD', 'SHLVL', 'PS1', 'PS2', 'TERM_SESSION_ID', 'ZDOTDIR_ORIG']);

/** Folders a GUI app may be missing from PATH, used only when the shell cannot be asked. */
function wellKnownPath(home) {
  return ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', join(home, '.local', 'bin'), join(home, '.bun', 'bin'), join(home, '.volta', 'bin')];
}

function withPath(env, extra) {
  const have = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const merged = [...have, ...extra.filter((dir) => !have.includes(dir))];
  return { ...env, PATH: merged.join(delimiter) };
}

/** Parses `env -0` output found between the two markers. */
export function parseEnvDump(output) {
  const start = output.indexOf(MARK);
  const end = output.lastIndexOf(MARK);
  if (start < 0 || end <= start) return null;
  const body = output.slice(start + MARK.length, end);
  const env = {};
  for (const entry of body.split('\0')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const key = entry.slice(0, eq).replace(/^\n+/, '');
    if (!key || DROP.has(key)) continue;
    env[key] = entry.slice(eq + 1);
  }
  return env.PATH ? env : null;
}

function runShell(shell) {
  const script = `printf '%s' '${MARK}'; command env -0; printf '%s' '${MARK}'`;
  return new Promise((resolve) => {
    const child = execFile(
      shell,
      ['-ilc', script],
      { timeout: SHELL_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8', env: { ...process.env, KESTREL_RESOLVING_ENV: '1' }, cwd: homedir() },
      (error, stdout) => resolve({ error, stdout: stdout ?? '' }),
    );
    child.stdin?.end();
  });
}

/**
 * The environment the server should run with: the login shell's, over the app's own. `source`
 * says where it came from, for the log. Never rejects.
 */
export async function resolveShellEnv(base = process.env) {
  const home = base.HOME || homedir();
  const shell = base.SHELL || FALLBACK_SHELL;
  try {
    const { error, stdout } = await runShell(shell);
    const env = parseEnvDump(stdout);
    if (env) return { env: { ...base, ...env }, source: `login shell ${shell}` };
    const why = error ? (error.killed ? `timed out after ${SHELL_TIMEOUT_MS / 1000}s` : error.message) : 'printed no environment';
    return { env: withPath(base, wellKnownPath(home)), source: `fallback (${shell} ${why})` };
  } catch (error) {
    return { env: withPath(base, wellKnownPath(home)), source: `fallback (${String(error?.message ?? error)})` };
  }
}
