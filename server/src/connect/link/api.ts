// HTTP routes for Settings → Connections → Kestrel Connect. Behind the same token, Origin and Host
// checks as every route; no Kestrel tool and no paired device reaches them (they are not in
// CONNECT_OPS), so only the user at the desk signs in, out, or turns Connect on.
//
//   GET    /api/connect                       200 ConnectView
//   PATCH  /api/connect           { enabled }  200 ConnectView | 400 | 409 { error }
//   POST   /api/connect/sign-in                200 { url }: open it in the browser | 409 { error }
//   DELETE /api/connect/sign-in                204: the sign-in under way is cancelled
//   POST   /api/connect/sign-out               200 ConnectView
//   POST   /api/connect/join                   200 ConnectView: this computer asks again to be let in | 409
//   POST   /api/connect/join/confirm  { code }  200 ConnectView: the second code, shown on the device that let this one in (step 8a) | 400 | 409
//   POST   /api/connect/join/cancel            200 ConnectView: the key offered is not kept | 409
//   POST   /api/connect/requests/:id/open      200 ConnectView: start letting that device in (its code is typed next) | 409
//   POST   /api/connect/requests/:id/code { code }  200 ConnectView: the code shown on the device; right lets it in | 400 | 409
//   POST   /api/connect/requests/:id/refuse    200 ConnectView: Not me | 409
//   POST   /api/connect/requests/:id/dismiss   200 ConnectView: the second code was typed; stop showing it | 409
//   DELETE /api/connect/devices/:id            200 ConnectView: that device's access ends at once, it leaves the account, the key rotates | 409
//   PATCH  /api/connect/held  { keptOff?, attachments? }  200 ConnectView: what is no longer held is deleted | 400 | 409
//   GET    /api/connect/recovery               200 { words }: from this computer, which holds the key | 409
//   POST   /api/connect/recovery  { words }    200 ConnectView: this computer is let in with the words | 409
//   POST   /api/connect/recovery/put-away      200 ConnectView: the new words were written down
import { Refused } from '../../refused.ts';
import type { KestrelConnect } from './connect.ts';

export type ConnectAnswer = { status: number; body?: unknown };
type ReadBody = () => Promise<Record<string, unknown>>;

export async function connectRoute(parts: readonly string[], method: string, readBody: ReadBody, connect: KestrelConnect): Promise<ConnectAnswer | null> {
  if (parts[1] !== 'connect' || parts.length > 5) return null;
  try {
    if (parts.length === 2) {
      if (method === 'GET') return { status: 200, body: connect.view() };
      if (method !== 'PATCH') return null;
      const body = await readBody();
      if (typeof body.enabled !== 'boolean') return { status: 400, body: { error: 'enabled must be true or false.' } };
      return { status: 200, body: await connect.setEnabled(body.enabled) };
    }
    if (parts[2] === 'recovery' && parts.length === 4 && parts[3] === 'put-away' && method === 'POST') return { status: 200, body: await connect.recoveryPutAway() };
    if (parts[2] === 'join' && method === 'POST') {
      if (parts.length === 3) return { status: 200, body: await connect.askToJoin() };
      if (parts.length === 4 && parts[3] === 'cancel') return { status: 200, body: await connect.cancelJoin() };
      if (parts.length !== 4 || parts[3] !== 'confirm') return null;
      const body = await readBody();
      if (typeof body.code !== 'string') return { status: 400, body: { error: 'code must be the six digits shown on the device that let this one in.' } };
      return { status: 200, body: await connect.confirmJoin(body.code) };
    }
    if (parts[2] === 'requests' && parts.length === 5 && method === 'POST') {
      const id = parts[3] as string;
      if (parts[4] === 'open') return { status: 200, body: await connect.openRequest(id) };
      if (parts[4] === 'refuse') return { status: 200, body: await connect.refuseRequest(id) };
      if (parts[4] === 'dismiss') return { status: 200, body: connect.dismissRequest(id) };
      if (parts[4] !== 'code') return null;
      const body = await readBody();
      if (typeof body.code !== 'string') return { status: 400, body: { error: 'code must be the six digits shown on the other device.' } };
      return { status: 200, body: await connect.typeCode(id, body.code) };
    }
    if (parts.length > 4) return null;
    if (parts.length !== 3 && parts[2] !== 'devices') return null;
    if (parts[2] === 'held' && method === 'PATCH') {
      const body = await readBody();
      if (body.keptOff !== undefined && (!Array.isArray(body.keptOff) || body.keptOff.some((p) => typeof p !== 'string'))) return { status: 400, body: { error: 'keptOff must be a list of project ids.' } };
      if (body.attachments !== undefined && typeof body.attachments !== 'boolean') return { status: 400, body: { error: 'attachments must be true or false.' } };
      return { status: 200, body: await connect.setHeld({ ...(body.keptOff !== undefined ? { keptOff: body.keptOff as string[] } : {}), ...(body.attachments !== undefined ? { attachments: body.attachments as boolean } : {}) }) };
    }
    if (parts[2] === 'recovery' && method === 'GET') return { status: 200, body: connect.recoveryWords() };
    if (parts[2] === 'recovery' && method === 'POST') {
      const body = await readBody();
      if (typeof body.words !== 'string') return { status: 400, body: { error: 'words must be the 24 recovery words.' } };
      return { status: 200, body: await connect.recover(body.words) };
    }
    if (parts[2] === 'sign-in' && method === 'POST') return { status: 200, body: await connect.signIn() };
    if (parts[2] === 'sign-in' && method === 'DELETE') {
      connect.cancelSignIn();
      return { status: 204 };
    }
    if (parts[2] === 'sign-out' && method === 'POST' && parts.length === 3) return { status: 200, body: await connect.signOut() };
    if (parts[2] === 'devices' && parts.length === 4 && method === 'DELETE') return { status: 200, body: await connect.removeDevice(parts[3] as string) };
    return null;
  } catch (error) {
    if (error instanceof Refused) return { status: 409, body: { error: error.message } };
    throw error;
  }
}
