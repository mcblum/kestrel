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
//   PATCH  /api/connect/name  { name }    200 ConnectView: this computer's name ('' is its host name); kept here, sent to the service when it can be | 400 | 409
//   PATCH  /api/connect/devices/:id { name }  200 ConnectView: renames a device of the account (a label only) | 400 | 409
//   DELETE /api/connect/devices/:id            200 ConnectView: that device's access ends at once, it leaves the account, the key rotates | 409
//   PATCH  /api/connect/held  { keptOff?, attachments? }  200 ConnectView: what is no longer held is deleted | 400 | 409
//   GET    /api/connect/recovery               200 { words }: from this computer, which holds the key | 409
//   POST   /api/connect/recovery  { words }    200 ConnectView: this computer is let in with the words | 409
//   POST   /api/connect/recovery/put-away      200 ConnectView: the new words were written down
//   GET    /api/connect/setup                  200 SetupList: Set up this computer, built from every computer's set-up record | 409
//   POST   /api/connect/setup/record           204: Connections was opened; this computer's set-up record is written again if it changed
//   POST   /api/connect/setup/dismiss { ids, dismissed }  200 SetupList: lines dismissed or restored on this computer | 400 | 409
//   GET    /api/connect/setup/runs             200 SetupRuns: how each line run since the page opened stands
//   POST   /api/connect/setup/run { line, input? } | { section }  200 RunReport: carried out by the server from its own list | 409 { error }
//   POST   /api/connect/setup/undo { token }   204: what that run did is put back, where Kestrel can | 409
//   DELETE /api/connect/setup/runs             204: the page was left; results from before go
//   POST   /api/connect/setup/copy { line, from }  200 CopyReport: a line's missing values copied from that computer, on Allow there; names only | 400 | 409
//   GET    /api/connect/setup/value-requests   200 ValueRequestView[]: other computers' requests waiting on the person here; names only
//   POST   /api/connect/setup/value-requests/:id { allow }  200 { sent: SentReport | null }: Allow reads and sends the values; Deny sends nothing | 400 | 409
//   GET    /api/connect/setup/sent             200 SentEntry[]: what this computer sent, by name (onboarding.md 19.14)
//   DELETE /api/connect/setup/sent             200 { undo }: the record is emptied; the token puts it back
//   POST   /api/connect/setup/sent/restore { token }  200 SentEntry[]: Undo of the above | 409
import { Refused } from '../../refused.ts';
import type { KestrelConnect } from './connect.ts';
import { SETUP_GROUPS, type SetupGroup } from '../../shared/setup-list.ts';
import type { SetupSteps } from '../../setup-actions/steps.ts';

export type ConnectAnswer = { status: number; body?: unknown };
type ReadBody = () => Promise<Record<string, unknown>>;

const SECTIONS: readonly string[] = SETUP_GROUPS.map((g) => g.id);

/** Set up this computer's own routes: dismiss, run, undo. Only from the window; a phone has no operation for them. */
async function setupStepRoute(part: string, method: string, readBody: ReadBody, steps: SetupSteps): Promise<ConnectAnswer | null> {
  if (part === 'runs' && method === 'GET') return { status: 200, body: steps.runs() };
  if (part === 'runs' && method === 'DELETE') {
    steps.forget();
    return { status: 204 };
  }
  if (method !== 'POST') return null;
  const body = await readBody();
  if (part === 'dismiss') {
    if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'string') || typeof body.dismissed !== 'boolean') return { status: 400, body: { error: 'ids must list lines and dismissed must be true or false.' } };
    return { status: 200, body: await steps.dismiss(body.ids as string[], body.dismissed) };
  }
  if (part === 'run') {
    if (typeof body.section === 'string') {
      if (!SECTIONS.includes(body.section)) return { status: 400, body: { error: 'section must be one of the list\'s sections.' } };
      return { status: 200, body: await steps.runSection(body.section as SetupGroup) };
    }
    if (typeof body.line !== 'string') return { status: 400, body: { error: 'line must name a line, or section a section.' } };
    const input = typeof body.input === 'object' && body.input !== null && !Array.isArray(body.input) ? Object.fromEntries(Object.entries(body.input).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length <= 4000)) : {};
    return { status: 200, body: await steps.runLine(body.line, input) };
  }
  if (part === 'undo') {
    if (typeof body.token !== 'string') return { status: 400, body: { error: 'token must be the one the run answered.' } };
    await steps.undo(body.token);
    return { status: 204 };
  }
  return null;
}

/** Copying set-up values (onboarding.md section 19): the button here, and the request card for another computer's ask. */
async function valuesRoute(parts: readonly string[], method: string, readBody: ReadBody, connect: KestrelConnect): Promise<ConnectAnswer | null> {
  const values = connect.values;
  if (parts[3] === 'copy' && parts.length === 4 && method === 'POST') {
    const body = await readBody();
    if (typeof body.line !== 'string' || typeof body.from !== 'string') return { status: 400, body: { error: 'line must name a line and from the computer to copy from.' } };
    return { status: 200, body: await connect.copyValues(body.line, body.from) };
  }
  if (!values) return null;
  if (parts[3] === 'value-requests' && parts.length === 4 && method === 'GET') return { status: 200, body: values.view() };
  if (parts[3] === 'value-requests' && parts.length === 5 && method === 'POST') {
    const body = await readBody();
    if (typeof body.allow !== 'boolean') return { status: 400, body: { error: 'allow must be true or false.' } };
    return { status: 200, body: { sent: await values.answer(parts[4]!, body.allow) } };
  }
  if (parts[3] === 'sent' && parts.length === 4 && method === 'GET') return { status: 200, body: await values.sent() };
  if (parts[3] === 'sent' && parts.length === 4 && method === 'DELETE') return { status: 200, body: { undo: await values.clearSent() } };
  if (parts[3] === 'sent' && parts.length === 5 && parts[4] === 'restore' && method === 'POST') {
    const body = await readBody();
    if (typeof body.token !== 'string') return { status: 400, body: { error: 'token must be the one Clear answered.' } };
    return { status: 200, body: await values.restoreSent(body.token) };
  }
  return null;
}

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
    if (parts[2] === 'setup') {
      const steps = connect.steps;
      if (parts.length === 3 && method === 'GET') return { status: 200, body: steps ? await steps.list() : await connect.setupList() };
      const copying = await valuesRoute(parts, method, readBody, connect);
      if (copying) return copying;
      if (parts.length === 4 && steps) {
        const step = await setupStepRoute(parts[3]!, method, readBody, steps);
        if (step) return step;
      }
      if (parts.length === 4 && parts[3] === 'record' && method === 'POST') {
        connect.setupRefresh();
        return { status: 204 };
      }
      return null;
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
    if ((parts[2] === 'name' && parts.length === 3) || (parts[2] === 'devices' && parts.length === 4)) {
      if (method === 'PATCH') {
        const body = await readBody();
        if (typeof body.name !== 'string') return { status: 400, body: { error: 'name must be text.' } };
        return { status: 200, body: parts[2] === 'name' ? await connect.setComputerName(body.name) : await connect.renameDevice(parts[3] as string, body.name) };
      }
    }
    if (parts[2] === 'devices' && parts.length === 4 && method === 'DELETE') return { status: 200, body: await connect.removeDevice(parts[3] as string) };
    return null;
  } catch (error) {
    if (error instanceof Refused) return { status: 409, body: { error: error.message } };
    throw error;
  }
}
