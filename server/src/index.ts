// Kestrel server entry point: the app's (Electron starts it, as do `pnpm dev:server` and `pnpm demo`). The wiring
// is in start-server.ts, which the worker node's entry (node.ts) calls as well; this only says what it read from
// the environment.
import { dataDir as resolveDataDir } from './data-dir.ts';
import { stopOnSignals } from './process-exit.ts';
import { startKestrel } from './start-server.ts';

// Outside any repository, so worktrees never sit inside another project's tree.
const server = await startKestrel({
  kind: 'app',
  dataDir: resolveDataDir(),
  port: Number(process.env.KESTREL_PORT ?? 4317),
  uiOrigins: (process.env.KESTREL_UI_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173').split(',').map((s) => s.trim()),
  // The Electron shell makes the token itself and passes it in; otherwise the server makes one.
  token: process.env.KESTREL_TOKEN,
  env: process.env,
});
stopOnSignals(server, { exitOnStdinClose: process.env.KESTREL_EXIT_ON_STDIN_CLOSE === '1' });
