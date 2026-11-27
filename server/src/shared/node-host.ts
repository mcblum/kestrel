// What a worker node's status says about the machine it is installed on (docs/designs/worker-nodes.md, section 4):
// lingering, the service, free disk in Kestrel's folder, and the installed bundle's version. The facts are gathered
// by node-control/host-facts.ts; this words them, purely, for `status` when the node answers and for the shorter
// status the terminal gives when it does not.
import { enableLingerCommand, NODE_UNIT_NAME, WITHOUT_LINGERING, type Lingering, type ServiceState } from './node-service.ts';

export interface HostFacts {
  /** The user the node runs as, for the lingering command. */
  user: string;
  lingering: Lingering;
  service: ServiceState;
  /** Free space where Kestrel keeps its data, or null when it could not be measured. */
  disk: { path: string; freeBytes: number } | null;
  /** The installed bundle (`~/.kestrel/node/current`), or null when this is not an installed node (a checkout). */
  bundle: { version: string; path: string } | null;
}

/** Below this, `status` says the disk is low: worktrees and agents' caches need room. */
export const LOW_DISK_BYTES = 2 * 1024 ** 3;

const UNITS = ['bytes', 'KB', 'MB', 'GB', 'TB'] as const;

/** "12.3 GB", "512 MB". */
export function sizeText(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${Math.round(value)} bytes` : `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${UNITS[unit]}`;
}

export function lingeringLine(lingering: Lingering, user: string): string {
  if (lingering === 'on') return 'Lingering: on (the node runs with nobody logged in, and starts after a reboot)';
  if (lingering === 'unknown') return 'Lingering: not known (this system has no systemd)';
  return `Lingering: off. ${WITHOUT_LINGERING} An administrator turns it on with: ${enableLingerCommand(user)}`;
}

/**
 * How the node is kept running. `nodePid` is the running node's process id when the node itself answers, and null
 * when the terminal answers because no node does.
 */
export function serviceLine(service: ServiceState, nodePid: number | null): string {
  if (service.manager === 'none') return 'Service: none (no systemd user manager here). Start the node by hand with "kestrel node run".';
  if (!service.installed) return nodePid === null ? 'Service: not installed. Start the node by hand with "kestrel node run".' : 'Service: not installed; this node was started by hand.';
  if (!service.active) return nodePid === null ? `Service: installed (${NODE_UNIT_NAME}), not running. Start it with "kestrel node start".` : `Service: installed (${NODE_UNIT_NAME}) but not running; this node was started by hand.`;
  if (nodePid === null) return `Service: running (${NODE_UNIT_NAME}), but the node does not answer yet. See "kestrel node logs".`;
  return service.mainPid === nodePid ? `Service: running under systemd (${NODE_UNIT_NAME})` : `Service: ${NODE_UNIT_NAME} is running too; this node was started by hand.`;
}

export function diskLine(disk: HostFacts['disk']): string {
  if (!disk) return 'Free disk: could not be measured.';
  const low = disk.freeBytes < LOW_DISK_BYTES ? ' Low: sessions’ worktrees and the agents need room.' : '';
  return `Free disk in ${disk.path}: ${sizeText(disk.freeBytes)}.${low}`;
}

/** The installed bundle, and a restart to take it when the running node is older. `running` is the running node's version, or null when none answers. */
export function bundleLine(bundle: HostFacts['bundle'], running: string | null): string {
  if (!bundle) return 'Installed bundle: none (this node runs from a checkout).';
  const restart = running && running !== bundle.version ? ` The node runs ${running}: restart it to use ${bundle.version} ("kestrel node stop", then "kestrel node start").` : '';
  return `Installed bundle: ${bundle.version} (${bundle.path}).${restart}`;
}

/** Every line about the machine, in order. */
export function hostLines(host: HostFacts, nodePid: number | null, running: string | null): string[] {
  return [serviceLine(host.service, nodePid), lingeringLine(host.lingering, host.user), diskLine(host.disk), bundleLine(host.bundle, running)];
}

/** `kestrel node status` when no node answers: that, and what the terminal can see of the machine. */
export function offlineStatusLines(socketPath: string, host: HostFacts): string[] {
  return [`No worker node is running here: nothing answers at ${socketPath}.`, ...hostLines(host, null, null)];
}
