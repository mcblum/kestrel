// The three kinds of computer Kestrel runs on, and the words for each. Pure and browser-safe: the
// server says which one it is on (`hostPlatform` in host.ts) and the page words things to match.
// Anything that works on only some of them refuses on the others with a reason, never silently.

export type Platform = 'mac' | 'windows' | 'linux';

/** Node's `process.platform`, as one of the three. Any other Unix is treated as Linux. */
export function platformOf(nodePlatform: string): Platform {
  if (nodePlatform === 'darwin') return 'mac';
  if (nodePlatform === 'win32') return 'windows';
  return 'linux';
}

export const PLATFORM_NAME: Record<Platform, string> = { mac: 'macOS', windows: 'Windows', linux: 'Linux' };

/** What the system's own file browser is called, for "Show in …". */
export const FILE_MANAGER_NAME: Record<Platform, string> = { mac: 'Finder', windows: 'File Explorer', linux: 'the file manager' };

/** The menu item that shows a file or folder in the file manager. One wording for every menu. */
export const showInFileManager = (platform: Platform): string => `Show in ${FILE_MANAGER_NAME[platform]}`;

/** "this Mac" where it is one, "this computer" elsewhere. */
export const thisComputer = (platform: Platform): string => (platform === 'mac' ? 'this Mac' : 'this computer');
