// `kestrel upgrade [version]`: the same as running the install command again (docs/designs/worker-nodes.md,
// section 4). The bundle carries the install script (share/install.sh); it is copied out of the bundle it is
// about to replace and run with the terminal, on the channel of the version installed now (a beta's node follows the
// betas), or for the version given. The script checks the checksum before anything is unpacked, keeps Kestrel's data
// and the version that ran before, restarts the node and goes on to `kestrel node configure`.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeInstallPaths } from '../shared/node-service.ts';

/** The install script inside a bundle. */
export const BUNDLE_INSTALLER = 'share/install.sh';

/**
 * Its name in the bundles before it was renamed (0.0.34-beta.1), used only when a bundle has no `BUNDLE_INSTALLER`.
 * `kestrel upgrade` reads the installed bundle, which is the one running it, so this is for a `current` that is older
 * than the command (a checkout's, or one moved back by hand). That old copy finds the newest version by a published
 * name that was never served, so it needs the version given.
 */
export const OLD_BUNDLE_INSTALLER = 'share/install-node.sh';

export type UpgradeChannel = 'stable' | 'beta';

/** A beta's node follows the betas; a release's follows the releases. */
export const channelOfVersion = (version: string): UpgradeChannel => (/-beta\.\d+$/.test(version) ? 'beta' : 'stable');

export type UpgradePlan = { ok: true; script: string; args: string[]; channel: UpgradeChannel } | { ok: false; reason: string };

/** The installed bundle: its version, and which install script it carries (null: none). */
export interface InstalledBundle {
  version: string | null;
  installer: typeof BUNDLE_INSTALLER | typeof OLD_BUNDLE_INSTALLER | null;
  current: string;
}

/** Which install script a bundle carries, from whether each name is there: the new name first. */
export const installerOf = (has: (path: string) => boolean): InstalledBundle['installer'] =>
  has(BUNDLE_INSTALLER) ? BUNDLE_INSTALLER : has(OLD_BUNDLE_INSTALLER) ? OLD_BUNDLE_INSTALLER : null;

/** What to run, from the installed bundle. Pure. */
export function upgradePlan(installed: InstalledBundle, asked: string | undefined): UpgradePlan {
  if (!installed.version) return { ok: false, reason: `There is no installed node at ${installed.current} to upgrade. Run the install command to install one.` };
  if (!installed.installer) return { ok: false, reason: `This node's bundle (${installed.version}) has no install script in it. Run the install command again: it upgrades in place.` };
  return { ok: true, script: join(installed.current, installed.installer), args: asked ? [asked] : [], channel: channelOfVersion(installed.version) };
}

/** The installed bundle as it is on disk: `kestrel upgrade` and a node's own update (node-update/) read it the same way. */
export function installedBundle(home: string): InstalledBundle {
  const { current } = nodeInstallPaths(home);
  let version: string | null = null;
  try {
    version = readFileSync(join(current, 'VERSION'), 'utf8').trim() || null;
  } catch {
    version = null;
  }
  return { version, installer: installerOf((path) => existsSync(join(current, path))), current };
}

/** Runs the plan: the script copied out first, then `sh` with the terminal. Resolves with its exit code. */
export async function upgradeFromTerminal(home: string, asked: string | undefined): Promise<number> {
  const plan = upgradePlan(installedBundle(home), asked);
  if (!plan.ok) return console.error(plan.reason), 1;
  const dir = mkdtempSync(join(tmpdir(), 'kestrel-upgrade-'));
  const copy = join(dir, 'install.sh');
  try {
    copyFileSync(plan.script, copy);
    return await new Promise<number>((resolve) => {
      const child = spawn('/bin/sh', [copy, ...plan.args], { stdio: 'inherit', env: { ...process.env, KESTREL_NODE_CHANNEL: plan.channel } });
      child.once('error', (error) => (console.error(`Could not run the install script: ${error.message}`), resolve(1)));
      child.once('exit', (code, signal) => resolve(code ?? (signal ? 130 : 1)));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
