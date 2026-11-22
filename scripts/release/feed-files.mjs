// The names of a release's files, by platform: what electron-builder calls each artifact
// (app/electron-builder.config.cjs) and what electron-updater calls each platform's feed. One
// place, so the feed writer, the build scripts and the tests cannot disagree.

/** electron-builder's name for an architecture in an AppImage's file name. */
const appImageArch = (arch) => (arch === 'x64' ? 'x86_64' : arch);

/**
 * @param {'mac' | 'win' | 'linux'} platform
 * @param {'x64' | 'arm64'} arch
 * @param {string} version
 * @returns {{ feed: string, files: string[], blockmaps: string[] }} the feed's file name, the
 *   artifacts it lists (the first is what the updater downloads) and the blockmaps beside them.
 */
export function feedFiles(platform, arch, version) {
  if (platform === 'mac') {
    const zip = `Kestrel-${version}-${arch}-mac.zip`;
    return { feed: 'latest-mac.yml', files: [zip, `Kestrel-${version}-${arch}.dmg`], blockmaps: [`${zip}.blockmap`] };
  }
  if (platform === 'win') {
    const exe = `Kestrel-Setup-${version}-${arch}.exe`;
    return { feed: 'latest.yml', files: [exe], blockmaps: [`${exe}.blockmap`] };
  }
  if (platform === 'linux') {
    // electron-updater asks for latest-linux.yml on x64 and latest-linux-<arch>.yml elsewhere.
    return { feed: arch === 'x64' ? 'latest-linux.yml' : `latest-linux-${arch}.yml`, files: [`Kestrel-${version}-${appImageArch(arch)}.AppImage`], blockmaps: [] };
  }
  throw new Error(`no feed for ${platform}`);
}
