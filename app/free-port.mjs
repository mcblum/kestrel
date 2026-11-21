// A free local port. On its own, with no Electron import, because scripts/dev.mjs asks for one
// under plain Node before Electron exists (server-process.mjs needs Electron through paths.mjs).
import { createServer } from 'node:net';

export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}
