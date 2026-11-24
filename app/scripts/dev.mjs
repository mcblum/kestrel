// `pnpm dev:app`: starts the Vite dev server on a free port, then the Electron app pointed at it.
// The app starts its own Kestrel server on another free port, so this never collides with
// `pnpm dev:server` / `pnpm dev:ui` (which use 4317 and 5173). Set KESTREL_DATA_DIR to keep
// this app's sessions apart from a dev:server you are running (they share ~/.kestrel-dev otherwise).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../free-port.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const electron = createRequire(join(here, '..', 'package.json'))('electron');
const port = await freePort();
const url = `http://127.0.0.1:${port}`;

// Vite is started directly (not through pnpm) so stopping it really stops it.
const viteBin = join(root, 'ui', 'node_modules', 'vite', 'bin', 'vite.js');
const vite = spawn(process.execPath, [viteBin, '--port', String(port), '--strictPort'], { cwd: join(root, 'ui'), stdio: ['ignore', 'pipe', 'inherit'] });
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  vite.kill('SIGTERM');
  process.exit(code);
};
vite.on('exit', (code) => !stopping && (console.error('vite exited', code), stop(1)));
await new Promise((resolve) => vite.stdout.on('data', (d) => (process.stdout.write(d), String(d).includes('Local:') && resolve())));

const app = spawn(electron, ['.'], { cwd: join(here, '..'), stdio: 'inherit', env: { ...process.env, KESTREL_UI_URL: url } });
app.on('exit', (code) => stop(code ?? 0));
// Stopped from the terminal (Ctrl-C, `pnpm dev:restart`): a deliberate quit, so the app is told
// with SIGUSR2, which main.mjs takes as "quit without asking", stopping any agent at work. SIGTERM
// would reach Electron's own quit and wait on the app's quit check (quit-guard.mjs). Windows has
// no signals: there the app is ended outright, as before.
const quitFromTerminal = () => app.kill(process.platform === 'win32' ? 'SIGTERM' : 'SIGUSR2');
process.on('SIGINT', () => (quitFromTerminal(), stop(0)));
process.on('SIGTERM', () => (quitFromTerminal(), stop(0)));
