// Gathers what `status` says about the machine (shared/node-host.ts): whether systemd keeps the node running,
// lingering, free disk where Kestrel keeps its data, and the installed bundle. Used by the running node and by the
// terminal when no node answers. Every way to learn a fact is passed in, so tests cover a Linux box from anywhere;
// nothing here throws: a fact that cannot be learnt is said to be unknown.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statfsSync } from 'node:fs';
import { userInfo } from 'node:os';
import type { HostFacts } from '../shared/node-host.ts';
import { LINGER_DIR, lingeringOf, NODE_UNIT_NAME, nodeInstallPaths, SERVICE_PROPERTIES, serviceStateOf } from '../shared/node-service.ts';
import type { Platform } from '../shared/platform.ts';

/** Runs a program to its end: its output when it exited 0, else null. Never rejects. */
export type RunForOutput = (file: string, args: readonly string[]) => Promise<string | null>;

export const runForOutput: RunForOutput = (file, args) =>
  new Promise((resolve) => execFile(file, [...args], { timeout: 10_000, encoding: 'utf8' }, (error, stdout) => resolve(error ? null : stdout)));

export interface HostProbe {
  platform: Platform;
  home: string;
  dataDir: string;
  user: string;
  run: RunForOutput;
  exists(path: string): boolean;
  /** Free bytes for an unprivileged user on the file system holding `path`. */
  freeBytes(path: string): number;
  /** The file's text, or null. */
  read(path: string): string | null;
  realpath(path: string): string;
}

/** This machine, for real. */
export function hostProbe(platform: Platform, home: string, dataDir: string): HostProbe {
  return {
    platform,
    home,
    dataDir,
    user: currentUser(),
    run: runForOutput,
    exists: existsSync,
    freeBytes: (path) => {
      const fs = statfsSync(path);
      return fs.bavail * fs.bsize;
    },
    read: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    realpath: realpathSync,
  };
}

function currentUser(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? process.env.LOGNAME ?? 'you';
  }
}

/** The user unit's state, from `systemctl --user show`. Never throws. */
export async function serviceState(probe: Pick<HostProbe, 'platform' | 'run'>): Promise<HostFacts['service']> {
  if (probe.platform !== 'linux') return { manager: 'none' };
  return serviceStateOf(await probe.run('systemctl', ['--user', 'show', NODE_UNIT_NAME, `--property=${SERVICE_PROPERTIES}`]));
}

function disk(probe: HostProbe): HostFacts['disk'] {
  const path = probe.exists(probe.dataDir) ? probe.dataDir : probe.home;
  try {
    return { path, freeBytes: probe.freeBytes(path) };
  } catch {
    return null;
  }
}

function bundle(probe: HostProbe): HostFacts['bundle'] {
  const { current } = nodeInstallPaths(probe.home);
  if (!probe.exists(current)) return null;
  try {
    const path = probe.realpath(current);
    const version = probe.read(`${path}/VERSION`)?.trim();
    return version ? { version, path } : null;
  } catch {
    return null;
  }
}

export async function hostFacts(probe: HostProbe): Promise<HostFacts> {
  const linux = probe.platform === 'linux';
  const systemd = linux && probe.exists('/run/systemd/system');
  return {
    user: probe.user,
    lingering: lingeringOf(systemd, systemd && probe.exists(`${LINGER_DIR}/${probe.user}`)),
    service: await serviceState(probe),
    disk: disk(probe),
    bundle: bundle(probe),
  };
}
