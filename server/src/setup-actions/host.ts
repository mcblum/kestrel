// What decides an install's route on this computer (setup-install.ts `InstallHost`): whether Homebrew is
// here, whether `npm install -g` writes into a folder the user owns, whether a desktop can raise polkit's
// own prompt, and which Linux package manager there is. Read from what is on disk; nothing is run.
import { accessSync, constants } from 'node:fs';
import { dirname } from 'node:path';
import type { InstallHost } from '../shared/setup-install.ts';
import type { Platform } from '../shared/platform.ts';

const writable = (path: string): boolean => {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/** `find`: a program's path on Kestrel's PATH and the usual install folders, or null. */
export function installHostOf(platform: Platform, find: (name: string) => string | null, env: NodeJS.ProcessEnv, canWrite: (path: string) => boolean = writable): InstallHost {
  const npm = find('npm');
  // npm installs globally under its own prefix: the folder above the one `npm` is in.
  const npmUser = npm !== null && (platform === 'windows' || canWrite(dirname(dirname(npm))));
  const desktop = !!(env.DISPLAY || env.WAYLAND_DISPLAY);
  const packager = platform !== 'linux' ? null : find('apt-get') ? 'apt' : find('dnf') ? 'dnf' : find('pacman') ? 'pacman' : find('zypper') ? 'zypper' : null;
  return { brew: platform === 'mac' && find('brew') !== null, npmUser, polkit: platform === 'linux' && desktop && find('pkexec') !== null, packager };
}
