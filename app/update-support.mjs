// Whether this copy of Kestrel can update itself, and when it cannot, why: the words "Check for
// Updates…" shows. No Electron import, so it is tested.
//
//   macOS    the update zip, through Squirrel.Mac
//   Windows  the NSIS installer
//   Linux    the AppImage, which is replaced in place. A copy run any other way (unpacked, or from
//            a distribution's package) has no file electron-updater can replace.

/**
 * @param {{ platform: string, packaged: boolean, env: Record<string, string | undefined> }} where
 * @returns {{ enabled: true } | { enabled: false, reason: string }}
 */
export function updateSupport({ platform, packaged, env }) {
  if (!packaged) return { enabled: false, reason: 'A build run from a checkout does not update itself.' };
  if (env.KESTREL_UPDATES === 'off') return { enabled: false, reason: 'KESTREL_UPDATES is set to off.' };
  if (platform === 'linux' && !env.APPIMAGE) return { enabled: false, reason: 'On Linux only the AppImage updates itself. This copy was not started from one: download the new version to update.' };
  return { enabled: true };
}

/** Whether this error means "there is no feed (yet)", rather than a real failure. The feed is latest-mac.yml, latest.yml or latest-linux.yml. */
export function isMissingFeed(error) {
  const text = String(error?.message ?? error);
  return /\b404\b/.test(text) || /Cannot find latest(-[a-z0-9-]+)?\.yml/i.test(text) || /ERR_FILE_NOT_FOUND/.test(text);
}
