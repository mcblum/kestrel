// Which kind of computer this is, and the words that differ between them (the server's
// shared/platform.ts holds the words; this says which apply here). The desktop shell says the
// platform outright; a plain browser is on the same computer as the server (loopback only), so its
// own platform is the answer there.
import { FILE_MANAGER_NAME, PLATFORM_NAME, platformOf, showInFileManager, thisComputer as computerWords, type Platform } from '@kestrel/server/platform';

export function platform(): Platform {
  const fromShell = window.kestrelShell?.platform;
  if (fromShell) return platformOf(fromShell);
  if (/Mac|iPhone|iPad/.test(navigator.platform)) return 'mac';
  return /Win/.test(navigator.platform) ? 'windows' : 'linux';
}

/** "Finder", "File Explorer" or "the file manager". */
export const fileManager = (): string => FILE_MANAGER_NAME[platform()];
/** "Show in Finder", "Show in File Explorer", "Show in the file manager". */
export const showInManager = (): string => showInFileManager(platform());
/** "this Mac" or "this computer". */
export const thisComputer = (): string => computerWords(platform());
/** "macOS", "Windows" or "Linux". */
export const systemName = (): string => PLATFORM_NAME[platform()];
