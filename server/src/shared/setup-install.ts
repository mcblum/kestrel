// How a tool or an agent is installed on this computer (docs/designs/onboarding.md, 18.7): one table,
// the first route that fits, and how it runs. Kestrel never asks for or handles an administrator's
// password: a step that needs one either starts a command that raises the operating system's own prompt
// (`os-prompt`), or is shown to paste into a terminal (`paste`). Commands are Kestrel's own, fixed here;
// nothing from another machine's record becomes part of one except a tool's version, which is checked.
// Pure and browser-safe.
import type { Agent } from '../model.ts';
import type { Platform } from './platform.ts';

/** How a step runs here: as the user; through the OS's own administrator prompt; pasted by the person; a page opened. */
export type SetupRun = 'user' | 'os-prompt' | 'paste' | 'open';

export type SetupShell = 'sh' | 'powershell';

/** A command as shown, for this platform's shell. */
export interface SetupCommand {
  shell: SetupShell;
  text: string;
}

/** A route: how it runs, the argument list Kestrel runs (null for paste and open), what is shown, and a page for `open`. */
export interface InstallRecipe {
  run: SetupRun;
  argv: string[] | null;
  command: SetupCommand | null;
  url: string | null;
  /** Another tool this route needs first (Homebrew, Node). */
  needs: string | null;
}

/** What this computer has, which decides the route. Asked by the server; tests name it. */
export interface InstallHost {
  /** Homebrew is installed. */
  brew: boolean;
  /** `npm install -g` writes into a folder the user owns. */
  npmUser: boolean;
  /** `pkexec` and a desktop polkit agent are there (Linux). */
  polkit: boolean;
  /** The Linux system package manager, or null. */
  packager: 'apt' | 'dnf' | 'pacman' | 'zypper' | null;
}

export const NO_HOST: InstallHost = { brew: false, npmUser: false, polkit: false, packager: null };

export const shellOf = (platform: Platform): SetupShell => (platform === 'windows' ? 'powershell' : 'sh');

/** One argument quoted for a shell: bare when it is plainly safe. Pure. */
export function quoteArg(arg: string, shell: SetupShell): string {
  if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(arg)) return arg;
  if (shell === 'powershell') return `'${arg.replaceAll("'", "''")}'`;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** An argument list as one line for a shell. A `~/` at the start of an argument stays unquoted so the shell expands it. Pure. */
export function commandText(argv: readonly string[], shell: SetupShell): string {
  return argv.map((a) => (a.startsWith('~/') && /^~\/[A-Za-z0-9_@%+=:,./-]*$/.test(a) ? a : quoteArg(a, shell))).join(' ');
}

const cmd = (shell: SetupShell, text: string): SetupCommand => ({ shell, text });

/** A fixed script of Kestrel's own, run by the platform's shell. */
function script(platform: Platform, text: string, run: SetupRun = 'user'): InstallRecipe {
  const argv = platform === 'windows' ? ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', text] : ['/bin/sh', '-c', text];
  return { run, argv: run === 'user' || run === 'os-prompt' ? argv : null, command: cmd(shellOf(platform), text), url: null, needs: null };
}

function argvRecipe(platform: Platform, argv: string[], run: SetupRun, needs: string | null = null): InstallRecipe {
  return { run, argv: run === 'paste' ? null : argv, command: cmd(shellOf(platform), commandText(argv, shellOf(platform))), url: null, needs };
}

const paste = (platform: Platform, argv: string[]): InstallRecipe => argvRecipe(platform, argv, 'paste');

/** Homebrew formulae for the tools Kestrel knows. */
const BREW: Readonly<Record<string, string>> = { gh: 'gh', glab: 'glab', uv: 'uv', node: 'node', xcodegen: 'xcodegen', mise: 'mise', asdf: 'asdf', ruby: 'ruby', codex: 'codex', bun: 'oven-sh/bun/bun', deno: 'deno', pipx: 'pipx', python: 'python' };
/** Linux packages by package manager, where the name is the same everywhere it exists. */
const LINUX: Readonly<Record<string, string>> = { gh: 'gh', glab: 'glab', node: 'nodejs', git: 'git', ruby: 'ruby', pipx: 'pipx', python: 'python3' };
/** winget ids. */
const WINGET: Readonly<Record<string, string>> = { gh: 'GitHub.cli', glab: 'GLab.GLab', node: 'OpenJS.NodeJS.LTS', git: 'Git.Git', uv: 'astral-sh.uv', python: 'Python.Python.3.12', deno: 'DenoLand.Deno', bun: 'Oven-sh.Bun', ruby: 'RubyInstallerTeam.Ruby.3.3' };

export const HOMEBREW = 'Homebrew';
const HOMEBREW_SCRIPT = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
const XCODE_STORE = 'macappstores://apps.apple.com/app/id497799835';
const DOCKER_PAGE = 'https://www.docker.com/products/docker-desktop/';

function linuxPackage(tool: string, host: InstallHost, platform: Platform): InstallRecipe | null {
  const name = LINUX[tool];
  if (!name || !host.packager) return null;
  const install: Record<NonNullable<InstallHost['packager']>, string[]> = { apt: ['apt-get', 'install', '-y', name], dnf: ['dnf', 'install', '-y', name], pacman: ['pacman', '-S', '--noconfirm', name], zypper: ['zypper', '--non-interactive', 'install', name] };
  const argv = install[host.packager];
  return host.polkit ? argvRecipe(platform, ['pkexec', ...argv], 'os-prompt') : paste(platform, ['sudo', ...argv]);
}

/** A version written `name@1.2.3` in a tool's reasons, when it is a plain version. */
export function versionOf(tool: string, why: readonly string[]): string | null {
  for (const w of why) {
    const m = new RegExp(`(?:^|\\s)${tool}@([0-9][0-9A-Za-z.+-]{0,40})(?:\\s|$)`).exec(w);
    if (m) return m[1]!;
  }
  return null;
}

/** The route for a tool on this computer, or null when Kestrel knows none ("install it the way you usually do"). Pure. */
export function installRecipeOf(tool: string, platform: Platform, host: InstallHost, why: readonly string[] = []): InstallRecipe | null {
  const shell = shellOf(platform);
  if (tool === 'Xcode') return platform === 'mac' ? { run: 'open', argv: null, command: null, url: XCODE_STORE, needs: null } : null;
  if (tool === HOMEBREW) return platform === 'mac' ? { run: 'paste', argv: null, command: cmd(shell, HOMEBREW_SCRIPT), url: null, needs: null } : null;
  if (tool === 'docker') return platform === 'linux' ? null : { run: 'open', argv: null, command: null, url: DOCKER_PAGE, needs: null };
  // On a Mac, Homebrew's: it runs as the user, and one pnpm or yarn then uses the version each project names
  // in its own `packageManager`, so no one version is picked here for projects that pin different ones.
  if ((tool === 'pnpm' || tool === 'yarn') && platform === 'mac') return argvRecipe(platform, ['brew', 'install', tool], 'user', host.brew ? null : HOMEBREW);
  if (tool === 'pnpm' || tool === 'yarn') {
    const version = versionOf(tool, why);
    const argv = ['npm', 'install', '-g', version ? `${tool}@${version}` : tool];
    return host.npmUser ? argvRecipe(platform, argv, 'user', 'node') : { ...paste(platform, argv), needs: 'node' };
  }
  if (tool === 'git') {
    if (platform === 'mac') return argvRecipe(platform, ['xcode-select', '--install'], 'os-prompt');
    if (platform === 'windows') return argvRecipe(platform, ['winget', 'install', '--id', WINGET.git!, '-e', '--source', 'winget'], 'os-prompt');
    return linuxPackage(tool, host, platform);
  }
  if (tool === 'uv' && !(platform === 'mac' && host.brew)) {
    return platform === 'windows' ? script(platform, 'irm https://astral.sh/uv/install.ps1 | iex') : script(platform, 'curl -LsSf https://astral.sh/uv/install.sh | sh');
  }
  if (platform === 'mac') {
    const formula = BREW[tool];
    if (!formula) return null;
    return argvRecipe(platform, ['brew', 'install', formula], 'user', host.brew ? null : HOMEBREW);
  }
  if (platform === 'windows') {
    const id = WINGET[tool];
    return id ? argvRecipe(platform, ['winget', 'install', '--id', id, '-e', '--source', 'winget'], 'os-prompt') : null;
  }
  return linuxPackage(tool, host, platform);
}

/** The route for installing an agent. Pure. */
export function agentRecipeOf(agent: Agent, platform: Platform, host: InstallHost): InstallRecipe | null {
  if (agent === 'claude') return platform === 'windows' ? script(platform, 'irm https://claude.ai/install.ps1 | iex') : script(platform, 'curl -fsSL https://claude.ai/install.sh | bash');
  if (agent === 'codex') {
    if (platform === 'mac' && host.brew) return argvRecipe(platform, ['brew', 'install', 'codex'], 'user');
    const argv = ['npm', 'install', '-g', '@openai/codex'];
    return host.npmUser || platform === 'windows' ? argvRecipe(platform, argv, 'user', 'node') : { ...paste(platform, argv), needs: 'node' };
  }
  if (agent === 'opencode') {
    if (platform === 'windows') return argvRecipe(platform, ['npm', 'install', '-g', 'opencode-ai'], 'user', 'node');
    return script(platform, 'curl -fsSL https://opencode.ai/install | bash');
  }
  return null;
}
