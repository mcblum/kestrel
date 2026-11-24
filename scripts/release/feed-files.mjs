// The names of a release's files, by platform: what electron-builder calls each artifact
// (app/electron-builder.config.cjs) and what electron-updater calls each platform's feed. One
// place, so the feed writer, the build scripts and the tests cannot disagree. Which feeds a
// version goes to is the channel rule's (app/release-channel.mjs).
import { feedFileName, feedsFor } from '../../app/release-channel.mjs';

/** electron-builder's name for an architecture in an AppImage's file name. */
const appImageArch = (arch) => (arch === 'x64' ? 'x86_64' : arch);

/**
 * @param {'mac' | 'win' | 'linux'} platform
 * @param {'x64' | 'arm64'} arch
 * @param {string} version
 * @param {{ liveBeta?: string | null }} [live] what the beta feed serves now, for a stable release
 * @returns {{ feed: string, feeds: string[], files: string[], blockmaps: string[] }} the version's
 *   own feed file, every feed file it is written to (its own first), the artifacts the feed lists
 *   (the first is what the updater downloads) and the blockmaps beside them.
 */
export function feedFiles(platform, arch, version, live = {}) {
  const feeds = feedsFor(version, live).map((name) => feedFileName(name, platform, arch));
  const named = (rest) => ({ feed: feeds[0], feeds, ...rest });
  if (platform === 'mac') {
    const zip = `Kestrel-${version}-${arch}-mac.zip`;
    return named({ files: [zip, `Kestrel-${version}-${arch}.dmg`], blockmaps: [`${zip}.blockmap`] });
  }
  if (platform === 'win') {
    const exe = `Kestrel-Setup-${version}-${arch}.exe`;
    return named({ files: [exe], blockmaps: [`${exe}.blockmap`] });
  }
  if (platform === 'linux') {
    return named({ files: [`Kestrel-${version}-${appImageArch(arch)}.AppImage`], blockmaps: [] });
  }
  throw new Error(`no feed for ${platform}`);
}
