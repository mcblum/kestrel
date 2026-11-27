// For tests that run stub programs (the agents' and git checklists, OpenCode's start gate): a PATH that holds the
// test's stubs and a folder of links to only the plain tools a shell script needs, never /usr/bin or /bin whole. So a
// real gh, glab, git, ssh, npm, opencode, codex, claude or package manager on the computer running the tests can never
// answer in a stub's place and change the result; `realProgramsOn` lets a test say so. Used by tests only.
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** What the stubs' shell scripts use, and nothing that installs, signs in or talks to a host. */
export const PLAIN_TOOLS = ['sh', 'cat', 'cp', 'mv', 'ln', 'rm', 'rmdir', 'mkdir', 'chmod', 'touch', 'grep', 'sed', 'tr', 'cut', 'head', 'tail', 'wc', 'sort', 'ls', 'sleep', 'env', 'dirname', 'basename', 'printf', 'tar', 'gzip', 'date', 'true', 'false'] as const;

/** Programs that, found on a test's PATH and not a stub, would make the result depend on the computer. */
export const REAL_PROGRAMS = ['gh', 'glab', 'git', 'ssh', 'ssh-keygen', 'opencode', 'codex', 'claude', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'corepack', 'apt', 'apt-get', 'dpkg', 'dnf', 'yum', 'zypper', 'pacman', 'apk', 'brew', 'port', 'snap', 'pip', 'pip3', 'sudo'] as const;

const SYSTEM_DIRS = ['/bin', '/usr/bin'];

/** A folder in `root` holding links to the plain tools, from where the system keeps them. */
export function plainToolsBin(root: string, tools: readonly string[] = PLAIN_TOOLS): string {
  const dir = join(root, 'plain-bin');
  mkdirSync(dir, { recursive: true });
  for (const tool of tools) {
    const found = SYSTEM_DIRS.map((d) => join(d, tool)).find((p) => existsSync(p));
    if (found && !existsSync(join(dir, tool))) symlinkSync(found, join(dir, tool));
  }
  return dir;
}

/** The test's PATH: its stub folders first, then the plain tools only. */
export function hermeticPath(root: string, stubDirs: readonly string[], tools?: readonly string[]): string {
  return [...stubDirs, plainToolsBin(root, tools)].join(delimiter);
}

/** The real programs this PATH reaches outside the test's own stub folders: none, for a hermetic test. */
export function realProgramsOn(path: string, stubDirs: readonly string[]): string[] {
  const dirs = path.split(delimiter).filter((d) => d && !stubDirs.includes(d));
  return REAL_PROGRAMS.filter((program) => dirs.some((d) => existsSync(join(d, program))));
}
