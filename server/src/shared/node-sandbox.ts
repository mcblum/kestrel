// The command sandbox on a worker node (docs/designs/worker-nodes.md, section 6): Claude Code's sandbox on Linux runs
// bubblewrap, with socat for the network. Installing them needs an administrator, so the node only says the one
// command for its distribution and what happens without them. The install script (scripts/release/install-node.sh)
// is POSIX sh and says the same; its test reads this list, so the two cannot drift.
//
// Erasable TypeScript only: the install script's test imports this file with Node's own type stripping.

/** The package managers looked for, in the order the install script looks, with the command that installs both. */
export const SANDBOX_INSTALL_COMMANDS: readonly { manager: string; command: string }[] = [
  { manager: 'apt-get', command: 'sudo apt-get install -y bubblewrap socat' },
  { manager: 'dnf', command: 'sudo dnf install -y bubblewrap socat' },
  { manager: 'pacman', command: 'sudo pacman -S --needed bubblewrap socat' },
  { manager: 'zypper', command: 'sudo zypper install -y bubblewrap socat' },
  { manager: 'apk', command: 'sudo apk add bubblewrap socat' },
];

/** Said where no package manager on the list is found. */
export const SANDBOX_INSTALL_UNKNOWN = "your distribution's package manager (the packages are bubblewrap and socat)";

/** The programs the sandbox runs, by the package that brings each. */
export const SANDBOX_PROGRAMS: readonly { program: string; name: string }[] = [
  { program: 'bwrap', name: 'bubblewrap' },
  { program: 'socat', name: 'socat' },
];

/** What happens without them. */
export const WITHOUT_SANDBOX = 'Without them every command of a confined Claude session asks first.';

/** The restart they need: sandbox support is worked out once, when the node starts. */
export const SANDBOX_RESTART = 'kestrel-node stop && kestrel-node start';

/** The install command for the first package manager present, or null when none on the list is. */
export function sandboxInstallCommand(has: (program: string) => boolean): string | null {
  return SANDBOX_INSTALL_COMMANDS.find((c) => has(c.manager))?.command ?? null;
}

/** The sandbox packages that are missing, by name. */
export function missingSandboxPackages(has: (program: string) => boolean): string[] {
  return SANDBOX_PROGRAMS.filter((p) => !has(p.program)).map((p) => p.name);
}

/** What `kestrel-node status` says when the sandbox could not be used at the node's start. */
export const NODE_SANDBOX_MISSING = `bubblewrap and socat were not both installed when the node started. ${WITHOUT_SANDBOX} Run "kestrel-node agents" for the command that installs them, then restart the node: ${SANDBOX_RESTART}`;
