// The one rule for release channels, from the version string alone. Used by the shell's updater
// (updater.mjs) and by every release script (scripts/release/version.mjs is their command line),
// so a build, its feed and an installed copy cannot disagree about which channel a version is on.
// No Electron import, so it is tested.
//
//   1.2.3          stable: published to `latest-*.yml` (and `beta-*.yml`, so beta copies move to it)
//   1.2.3-beta.4   beta:   published to `beta-*.yml` only; no public download link, no Release
//
// Any other shape (1.2, 1.2.3-rc.1, 1.2.3+build) is refused with the reason, so a typo in
// app/package.json can never decide where a build goes.
//
// Feeds are named the way electron-updater's generic provider asks for them (Provider.js,
// getChannelFilePrefix): `<channel>-mac.yml` on a Mac, `<channel>.yml` on Windows,
// `<channel>-linux.yml` on Linux x64 and `<channel>-linux-<arch>.yml` on other Linux architectures.

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/;

/** The feed's base name for each channel: what electron-updater's `channel` is set to. */
export const FEED_CHANNEL = Object.freeze({ stable: 'latest', beta: 'beta' });

/**
 * @param {string} version
 * @returns {{ major: number, minor: number, patch: number, beta: number | null }}
 */
export function parseVersion(version) {
  const m = VERSION.exec(String(version ?? '').trim());
  if (!m) throw new Error(`"${version}" is not a Kestrel version: write 1.2.3 for a release or 1.2.3-beta.4 for a beta`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), beta: m[4] === undefined ? null : Number(m[4]) };
}

/** Whether `version` is a Kestrel version at all. */
export function isVersion(version) {
  return VERSION.test(String(version ?? '').trim());
}

/** @returns {'stable' | 'beta'} */
export function channelOf(version) {
  return parseVersion(version).beta === null ? 'stable' : 'beta';
}

/** Whether this is a beta build (`1.2.3-beta.4`). */
export function isBeta(version) {
  return channelOf(version) === 'beta';
}

/**
 * Semantic-version order: numbers part by part, and a beta comes before the release it leads to
 * (0.0.32-beta.3 < 0.0.32 < 0.0.33-beta.1). Negative, zero or positive, as for sort().
 */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] - y[k];
  if (x.beta === y.beta) return 0;
  if (x.beta === null) return 1;
  if (y.beta === null) return -1;
  return x.beta - y.beta;
}

/** Whether `a` is strictly newer than `b`. A missing `b` (nothing published) is older than anything. */
export function isNewer(a, b) {
  return b == null || compareVersions(a, b) > 0;
}

/** The newest of the versions given, ignoring missing ones; null when there are none. */
export function newest(...versions) {
  return versions.filter((v) => v != null).reduce((best, v) => (best == null || compareVersions(v, best) > 0 ? v : best), null);
}

/**
 * The feed file electron-updater reads for a channel's base name on a platform.
 * @param {'latest' | 'beta'} name
 * @param {'mac' | 'win' | 'linux'} platform
 * @param {'x64' | 'arm64'} arch
 */
export function feedFileName(name, platform, arch) {
  if (platform === 'mac') return `${name}-mac.yml`;
  if (platform === 'win') return `${name}.yml`;
  if (platform === 'linux') return arch === 'x64' ? `${name}-linux.yml` : `${name}-linux-${arch}.yml`;
  throw new Error(`no feed for ${platform}`);
}

/**
 * The feeds a release of `version` is written to, its own first. A stable release is written to
 * the beta feed too, so a copy on the beta channel moves to it, unless that feed already serves a
 * newer beta (then the beta stays, and beta copies keep it); a beta is written to the beta feed only.
 *
 * @param {string} version
 * @param {{ liveBeta?: string | null }} [live] what the beta feed serves now (null: nothing, or unknown)
 * @returns {Array<'latest' | 'beta'>}
 */
export function feedsFor(version, { liveBeta = null } = {}) {
  if (isBeta(version)) return [FEED_CHANNEL.beta];
  if (liveBeta != null && isVersion(liveBeta) && compareVersions(liveBeta, version) > 0) return [FEED_CHANNEL.stable];
  return [FEED_CHANNEL.stable, FEED_CHANNEL.beta];
}

/**
 * Is a release of `version` due, given what the live feeds serve? A stable release must be newer
 * than the stable feed (as always); a beta must be newer than both feeds, so a beta never follows
 * the release it leads to.
 *
 * @param {string} version
 * @param {{ stable: string | null, beta: string | null }} live
 * @returns {{ due: boolean, against: string | null, channel: 'stable' | 'beta' }}
 */
export function releaseDue(version, { stable, beta }) {
  const channel = channelOf(version);
  const against = channel === 'stable' ? stable : newest(stable, beta);
  return { due: isNewer(version, against), against, channel };
}

/**
 * Which feed a copy reads on its next check. Off the beta channel: the stable feed. On it: the
 * beta feed, unless it is missing or older than the stable feed (a stable release published before
 * the beta feed existed, or by an older publish step): then the stable feed. When neither could be
 * read, the beta feed, so the updater reports the real error.
 *
 * @param {{ beta: boolean, stable: string | null, betaFeed: string | null }} known
 * @returns {'latest' | 'beta'}
 */
export function feedToRead({ beta, stable, betaFeed }) {
  if (!beta) return FEED_CHANNEL.stable;
  if (betaFeed == null) return stable == null ? FEED_CHANNEL.beta : FEED_CHANNEL.stable;
  if (stable != null && compareVersions(stable, betaFeed) > 0) return FEED_CHANNEL.stable;
  return FEED_CHANNEL.beta;
}

/**
 * Whether an installed copy on `current` takes `offered`. Never a downgrade, whichever channel:
 * turning beta off leaves a beta installed until a stable version newer than it ships.
 */
export function takesUpdate(current, offered) {
  return isVersion(offered) && compareVersions(offered, current) > 0;
}

/**
 * The "Get beta versions" switch. What the person chose, when they have; otherwise on for a beta
 * build (the first beta is installed by hand on a copy that had no switch) and off for a release.
 *
 * @param {string} version this copy's own version
 * @param {{ beta?: unknown } | null} saved
 */
export function wantsBeta(version, saved) {
  if (saved && typeof saved.beta === 'boolean') return saved.beta;
  return isVersion(version) && isBeta(version);
}


/** The version a feed file says, from its `version:` line; null when it has none a Kestrel copy could take. */
export function versionInFeed(text) {
  const found = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(String(text ?? ''));
  return found && isVersion(found[1]) ? found[1] : null;
}
