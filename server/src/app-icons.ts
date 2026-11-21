// The icon of an app on this Mac, as a small PNG in a data URL, for the "Open in" button and its
// menu. Read from the app's own bundle: `Info.plist` names its icon file (`CFBundleIconFile`), and
// `sips` (part of macOS) scales that to a PNG. Commands run through execFile with argument arrays,
// never a shell. An app whose icon cannot be read simply has none: the menu shows its name alone.
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const PLUTIL = '/usr/bin/plutil';
const SIPS = '/usr/bin/sips';
/** Drawn at 14 to 16 CSS pixels; 64 keeps it sharp on a Retina screen and stays a few kilobytes. */
export const ICON_PX = 64;
const TIMEOUT_MS = 10_000;

const run = (command: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => execFile(command, [...args], { timeout: TIMEOUT_MS }, (error, out, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolve(out))));

/** Where `<app>.app` is: /Applications, the user's own Applications, or where macOS keeps its own apps. Null when it is in none. */
export function appBundle(app: string, home = homedir()): string | null {
  const places = ['/Applications', join(home, 'Applications'), '/System/Applications', '/System/Applications/Utilities', '/System/Library/CoreServices'];
  return places.map((dir) => join(dir, `${app}.app`)).find((path) => existsSync(path)) ?? null;
}

/** The icon file a bundle names, with `.icns` when the name has no extension. Pure. */
export function iconFileIn(bundle: string, named: string): string {
  const name = named.trim();
  return join(bundle, 'Contents', 'Resources', /\.[a-z0-9]+$/i.test(name) ? name : `${name}.icns`);
}

/** The app's icon as a PNG data URL, or null when it has none Kestrel can read. Never throws. */
export async function appIcon(bundle: string): Promise<string | null> {
  const scratch = mkdtempSync(join(tmpdir(), 'kestrel-icon-'));
  try {
    const named = await run(PLUTIL, ['-extract', 'CFBundleIconFile', 'raw', join(bundle, 'Contents', 'Info.plist')]);
    const source = iconFileIn(bundle, named);
    if (!named.trim() || !existsSync(source)) return null;
    const out = join(scratch, 'icon.png');
    await run(SIPS, ['-s', 'format', 'png', '-z', String(ICON_PX), String(ICON_PX), source, '--out', out]);
    return `data:image/png;base64,${readFileSync(out).toString('base64')}`;
  } catch {
    return null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The icons of several apps by id, read together. `bundleOf` says where each app is (null: not found). */
export async function appIcons(apps: readonly { id: string; app: string | null }[], bundleOf: (app: string) => string | null = appBundle): Promise<Record<string, string>> {
  const found = await Promise.all(
    apps.map(async ({ id, app }) => {
      const bundle = app ? bundleOf(app) : null;
      return [id, bundle ? await appIcon(bundle) : null] as const;
    }),
  );
  return Object.fromEntries(found.filter((entry): entry is readonly [string, string] => entry[1] !== null));
}
