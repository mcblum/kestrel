// HTTP routes for Settings → Connections → Kestrel Connect. Behind the same token, Origin and Host
// checks as every route; no Kestrel tool and no paired device reaches them (they are not in
// CONNECT_OPS), so only the user at the desk signs in, out, or turns Connect on.
//
//   GET    /api/connect                       200 ConnectView
//   PATCH  /api/connect           { enabled }  200 ConnectView | 400 | 409 { error }
//   POST   /api/connect/sign-in                200 { url }: open it in the browser | 409 { error }
//   DELETE /api/connect/sign-in                204: the sign-in under way is cancelled
//   POST   /api/connect/sign-out               200 ConnectView
//   POST   /api/connect/pairing                200 { code, expiresAt }: the pairing page's code | 409
//   DELETE /api/connect/pairing                204: the code is withdrawn
//   DELETE /api/connect/devices/:id            200 ConnectView: that device's access ends at once | 409
import { Refused } from '../../refused.ts';
import type { KestrelConnect } from './connect.ts';

export type ConnectAnswer = { status: number; body?: unknown };
type ReadBody = () => Promise<Record<string, unknown>>;

export async function connectRoute(parts: readonly string[], method: string, readBody: ReadBody, connect: KestrelConnect): Promise<ConnectAnswer | null> {
  if (parts[1] !== 'connect' || parts.length > 4) return null;
  try {
    if (parts.length === 2) {
      if (method === 'GET') return { status: 200, body: connect.view() };
      if (method !== 'PATCH') return null;
      const body = await readBody();
      if (typeof body.enabled !== 'boolean') return { status: 400, body: { error: 'enabled must be true or false.' } };
      return { status: 200, body: await connect.setEnabled(body.enabled) };
    }
    if (parts.length !== 3 && parts[2] !== 'devices') return null;
    if (parts[2] === 'sign-in' && method === 'POST') return { status: 200, body: await connect.signIn() };
    if (parts[2] === 'sign-in' && method === 'DELETE') {
      connect.cancelSignIn();
      return { status: 204 };
    }
    if (parts[2] === 'sign-out' && method === 'POST' && parts.length === 3) return { status: 200, body: await connect.signOut() };
    if (parts[2] === 'pairing' && parts.length === 3 && method === 'POST') return { status: 200, body: connect.startPairing() };
    if (parts[2] === 'pairing' && parts.length === 3 && method === 'DELETE') {
      connect.stopPairing();
      return { status: 204 };
    }
    if (parts[2] === 'devices' && parts.length === 4 && method === 'DELETE') return { status: 200, body: await connect.removeDevice(parts[3] as string) };
    return null;
  } catch (error) {
    if (error instanceof Refused) return { status: 409, body: { error: error.message } };
    throw error;
  }
}
