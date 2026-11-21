// Where the shell finds its parts, from a checkout and from the packaged app.
//
// Checkout (`pnpm dev:app`, `pnpm start`): the server runs from TypeScript with tsx, the UI comes
// from Vite (or ui/dist), and the SDK and the simulator helper find their own binaries.
//
// Packaged (Kestrel.app): the server is one built JavaScript file in Contents/Resources/server
// with node-pty beside it, the UI is in the app archive, and the Claude Code binary and the
// simulator helper are in Contents/Resources/bin, outside the archive so they can be executed.
import { app } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const isPackaged = app.isPackaged;

/** The built UI: inside the app archive when packaged, ui/dist in a checkout. */
export const uiDist = isPackaged ? join(here, 'ui') : join(here, '..', 'ui', 'dist');

export const preloadPath = join(here, 'preload.cjs');

/** The bird, for the Dock icon of an unpackaged app (a packaged one has its own .icns). */
export const devIconPath = join(here, '..', 'Brand', 'exports', 'icon-512.png');

/** How to start the server: the program's arguments and folder. */
export function serverLaunch() {
  if (isPackaged) {
    const dir = join(process.resourcesPath, 'server');
    return { kind: 'built', dir, entry: join(dir, 'index.mjs') };
  }
  return { kind: 'source', dir: join(here, '..', 'server'), entry: 'src/index.ts' };
}

/** Binaries the packaged app ships, by the variable the server reads them from. Empty from a checkout. */
export function bundledBinaries() {
  if (!isPackaged) return {};
  const bin = join(process.resourcesPath, 'bin');
  const found = {};
  const claude = join(bin, 'claude');
  const sim = join(bin, 'kestrel-sim');
  if (existsSync(claude)) found.KESTREL_CLAUDE_EXECUTABLE = claude;
  if (existsSync(sim)) found.KESTREL_SIM_HELPER = sim;
  return found;
}
