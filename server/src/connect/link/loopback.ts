// The loopback redirect for one sign-in (RFC 8252, section 7.3): a listener on 127.0.0.1 at a port
// the system picks, open only while one sign-in is under way, that takes exactly one request to
// `/callback` carrying the expected `state`, answers the browser with a short page, and closes.
// It is not Kestrel's server: nothing else is served, and the main listener's checks (security.ts)
// are untouched. The browser cannot send Kestrel's per-launch token, which is why this is apart.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LOOPBACK_HOST } from '../../security.ts';

export type CallbackResult = { code: string } | { error: string };

export interface LoopbackCallback {
  redirectUri: string;
  /** The one callback with this state; resolves once, then the listener is closed. */
  result: Promise<CallbackResult>;
  close(): void;
}

/** Waits this long for the browser; a sign-in left open ends on its own. */
export const SIGN_IN_WAIT_MS = 10 * 60_000;

const page = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px system-ui;margin:20vh auto;max-width:28rem;text-align:center;color:#222"><h1 style="font-size:20px">${title}</h1><p>${text}</p></body>`;

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function listenForCallback(expectedState: () => string | null, waitMs = SIGN_IN_WAIT_MS): Promise<LoopbackCallback> {
  let settle: (result: CallbackResult) => void = () => undefined;
  const result = new Promise<CallbackResult>((resolve) => (settle = resolve));
  let done = false;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`);
    const state = expectedState();
    if (done || req.method !== 'GET' || url.pathname !== '/callback' || !state || url.searchParams.get('state') !== state) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    done = true;
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error_description') ?? url.searchParams.get('error');
    const ok = Boolean(code) && !error;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(ok ? page('Signed in to Kestrel Connect', 'You can close this tab and go back to Kestrel.') : page('Sign-in did not finish', escape(error ?? 'The sign-in page sent no code.')));
    settle(ok ? { code: code as string } : { error: error ?? 'The sign-in page sent no code.' });
    close();
  });
  const timer = setTimeout(() => {
    settle({ error: 'The sign-in took too long. Try again.' });
    close();
  }, waitMs);
  timer.unref?.();
  function close() {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    redirectUri: `http://${LOOPBACK_HOST}:${port}/callback`,
    result,
    close: () => {
      settle({ error: 'Sign-in was cancelled.' });
      close();
    },
  };
}
