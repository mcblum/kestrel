import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import react from '@vitejs/plugin-react';
import { dataDir as resolveDataDir } from '../server/src/data-dir.ts';
import { defineConfig, type Plugin } from 'vite';

// The same rule the server uses, so the page reads the launch file the server wrote.
const dataDir = resolveDataDir();

const LAUNCH_PATH = '/__kestrel/launch';

function readLaunch(): string {
  try {
    const { port, token } = JSON.parse(readFileSync(join(dataDir, 'launch.json'), 'utf8'));
    return JSON.stringify({ port: Number(port), token: String(token) });
  } catch {
    return 'null'; // server not started yet; the page says so
  }
}

/**
 * Stands in for the Electron shell: hands the server's per-launch token to the page, at load
 * and again whenever the page asks (the token changes each time the server restarts).
 * The endpoint answers same-origin requests only and sends no CORS headers, so another site
 * open in the same browser cannot read it.
 */
function kestrelLaunch(): Plugin {
  return {
    name: 'kestrel-launch',
    transformIndexHtml() {
      return [{ tag: 'script', children: `window.__KESTREL__ = ${readLaunch().replace(/</g, '\\u003c')};`, injectTo: 'head-prepend' }];
    },
    configureServer(server) {
      server.middlewares.use(LAUNCH_PATH, (req, res) => {
        const site = req.headers['sec-fetch-site'];
        if (req.method !== 'GET' || (site !== undefined && site !== 'same-origin')) {
          res.statusCode = 403;
          res.end();
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(readLaunch());
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), kestrelLaunch()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
});
