// Starts and stops the Kestrel server as a child process.
//
// It runs on Electron's own Node (ELECTRON_RUN_AS_NODE): Electron 45 embeds Node 24, where
// `node:sqlite` works, so no system Node is needed. A child process, rather than the main
// process, so a crash cannot take the window down, and so quitting can stop the server (and the
// agents it runs) on purpose and wait for it.
//
// From a checkout it runs the TypeScript source through tsx; the packaged app runs the built
// JavaScript in Contents/Resources/server (paths.mjs).
import { spawn } from 'node:child_process';
import { app } from 'electron';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bundledBinaries, isPackaged, serverLaunch } from './paths.mjs';

export { freePort } from './free-port.mjs';
// The server gives itself three seconds (shared/shutdown.ts); this is the backstop after that.
const STOP_TIMEOUT_MS = 4000;
const START_TIMEOUT_MS = 20000;

/** @returns {Promise<{ stop(): Promise<void>, exited: Promise<number|null> }>} */
/** The arguments for Electron's Node: the built file, or the source through tsx. */
function serverArgs(launch) {
  if (launch.kind === 'built') return [launch.entry];
  // tsx is a dependency of the server package, so resolve it from there.
  const tsx = createRequire(join(launch.dir, 'package.json')).resolve('tsx/esm');
  return ['--import', pathToFileURL(tsx).href, launch.entry];
}

/**
 * `baseEnv` is the environment to run with (the login shell's, for a packaged app; see shell-env.mjs).
 * `writeLog`, when given, also gets everything the server prints (server-log.mjs).
 */
export async function startServer({ port, token, origin, dataDir, baseEnv = process.env, writeLog, vaultKey = null }) {
  const launch = serverLaunch();
  const child = spawn(process.execPath, serverArgs(launch), {
    cwd: launch.dir,
    // fd 3 carries the protected store's key (vault-key.mjs), read once by the server and closed.
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    env: {
      ...baseEnv,
      ...bundledBinaries(),
      // The installed app's data folder (~/.kestrel); a checkout uses ~/.kestrel-dev (server/src/data-dir.ts).
      ...(isPackaged ? { KESTREL_PACKAGED: '1' } : {}),
      // Names the release in a crash report (server/src/crash-reports/).
      KESTREL_APP_VERSION: app.getVersion(),
      ELECTRON_RUN_AS_NODE: '1',
      KESTREL_PORT: String(port),
      KESTREL_TOKEN: token,
      // Exactly the app's own origin; never a wildcard.
      KESTREL_UI_ORIGINS: origin,
      KESTREL_NO_LAUNCH_FILE: '1',
      KESTREL_EXIT_ON_STDIN_CLOSE: '1',
      ...(dataDir ? { KESTREL_DATA_DIR: dataDir } : {}),
      // Says where the key is, never what it is.
      ...(vaultKey ? { KESTREL_VAULT_KEY_FD: '3' } : {}),
    },
  });
  const keyPipe = child.stdio[3];
  if (vaultKey) keyPipe.end(vaultKey.toString('base64'));
  else keyPipe.end();
  let log = '';
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The Kestrel server did not start within ${START_TIMEOUT_MS / 1000}s.\n${log}`)), START_TIMEOUT_MS);
    let started = false;
    const onData = (chunk) => {
      process.stdout.write(`[server] ${chunk}`);
      writeLog?.(String(chunk));
      if (started) return;
      // Kept only until it is up: it is what the "did not start" errors quote.
      log += chunk;
      if (log.includes('[kestrel] server on')) {
        started = true;
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    exited.then((code) => {
      clearTimeout(timer);
      reject(new Error(`The Kestrel server exited (code ${code}) before it was ready.\n${log}`));
    });
  });
  await ready;

  return {
    exited,
    /** Ask the server to shut down (it stops agents and flushes the store), then force it if it hangs. */
    async stop() {
      if (child.exitCode !== null) return;
      child.stdin.end();
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
      await exited;
      clearTimeout(timer);
    },
  };
}
