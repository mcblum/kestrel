// Where an installed worker node lives and how systemd keeps it running (docs/designs/worker-nodes.md, section 4).
// Pure: the unit file's text, the install's folders, and what `systemctl --user show` and the linger file say,
// so the build script (which puts the unit in the bundle), `status`, `start`, `stop`, `logs` and `uninstall` read
// one copy. Erasable TypeScript only: the build script imports this file with Node's own type stripping.
import { SHUTDOWN_DEADLINE_MS } from './shutdown.ts';

/** The user unit's name. */
export const NODE_UNIT_NAME = 'kestrel-node.service';

/**
 * How long systemd waits after SIGTERM before it kills the node: longer than the server's own deadline for ending
 * its sessions' turns (shared/shutdown.ts), with room for the process to start and the store to close.
 */
export const UNIT_STOP_TIMEOUT_S = Math.ceil(SHUTDOWN_DEADLINE_MS / 1000) + 12;

/** The installed bundle's launcher, as the unit names it (`%h` is the user's home folder). */
export const UNIT_LAUNCHER = '%h/.kestrel/node/current/bin/kestrel-node';

/**
 * The `systemd --user` unit. Everything a node needs from its environment (the bundle's Node first on PATH, the
 * installed copy's data folder, the version, the Claude Code program) is set by the launcher, so a command typed in
 * a terminal and the service agree; the unit only starts it and keeps it running.
 */
export function serviceUnitText(): string {
  return [
    '# Kestrel worker node. Written by the install (install-node.sh) from the bundle; an upgrade writes it again.',
    '# Lingering keeps it running with nobody logged in, and starts it after a reboot. Only an administrator can',
    '# turn it on:  sudo loginctl enable-linger <user>      Status: kestrel-node status',
    '[Unit]',
    'Description=Kestrel worker node',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${UNIT_LAUNCHER} run`,
    // The server ends its sessions' turns on SIGTERM, within SHUTDOWN_DEADLINE_MS.
    'KillSignal=SIGTERM',
    `TimeoutStopSec=${UNIT_STOP_TIMEOUT_S}`,
    'Restart=on-failure',
    'RestartSec=5',
    // Whatever it writes is the user's alone: the store holds conversations.
    'UMask=0077',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** The folders and files of an installed node, under the user's home folder. */
export interface NodeInstallPaths {
  /** Kestrel's folder (the installed copy's data folder), the user's alone. */
  kestrel: string;
  /** The bundles, one folder per version, and `current`. */
  bundles: string;
  current: string;
  unit: string;
  /** The link on the user's PATH. */
  link: string;
}

/** Joined with `/`: a node is Linux, and this file stays free of Node's modules. */
export function nodeInstallPaths(home: string): NodeInstallPaths {
  const at = (...parts: string[]) => [home.replace(/\/+$/, ''), ...parts].join('/');
  return {
    kestrel: at('.kestrel'),
    bundles: at('.kestrel', 'node'),
    current: at('.kestrel', 'node', 'current'),
    unit: at('.config', 'systemd', 'user', NODE_UNIT_NAME),
    link: at('.local', 'bin', 'kestrel-node'),
  };
}

/** The unit as systemd sees it: no user manager at all, not installed, or installed and running or not. */
export type ServiceState = { manager: 'none' } | { manager: 'systemd'; installed: false } | { manager: 'systemd'; installed: true; active: boolean; mainPid: number | null };

/** The properties `serviceStateOf` reads, for `systemctl --user show <unit> --property=…`. */
export const SERVICE_PROPERTIES = 'LoadState,ActiveState,MainPID';

/** What `systemctl --user show` answered (null when it could not run, or there is no user manager), as the unit's state. */
export function serviceStateOf(shown: string | null): ServiceState {
  if (shown === null) return { manager: 'none' };
  const props = new Map<string, string>();
  for (const line of shown.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) props.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  if (!props.has('LoadState')) return { manager: 'none' };
  if (props.get('LoadState') !== 'loaded') return { manager: 'systemd', installed: false };
  const pid = Number(props.get('MainPID'));
  const active = props.get('ActiveState') === 'active' || props.get('ActiveState') === 'activating' || props.get('ActiveState') === 'reloading';
  return { manager: 'systemd', installed: true, active, mainPid: Number.isInteger(pid) && pid > 0 ? pid : null };
}

/** Whether the node keeps running with nobody logged in: systemd-logind keeps one file per user that has it on. */
export type Lingering = 'on' | 'off' | 'unknown';

export const LINGER_DIR = '/var/lib/systemd/linger';

/** From whether this is a systemd system at all, and whether the user's linger file is there. */
export const lingeringOf = (systemd: boolean, lingerFile: boolean): Lingering => (!systemd ? 'unknown' : lingerFile ? 'on' : 'off');

/** The one command that turns lingering on. It needs an administrator; nothing Kestrel runs uses sudo. */
export const enableLingerCommand = (user: string): string => `sudo loginctl enable-linger ${user}`;

/** What happens without lingering, said the same by the install and by `status`. */
export const WITHOUT_LINGERING = 'Without it the node stops when your last login session ends and does not start again after a reboot.';
