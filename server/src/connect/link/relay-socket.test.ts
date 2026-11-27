// The desk and the phone stand-in over real WebSockets, through a stand-in relay on loopback that
// speaks the service's contract (config, devices, the relay upgrade with its headers and refusals,
// routing by `to` within one account). No network beyond 127.0.0.1: the identity provider is a fake.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { memoryPersistence } from '../../persistence/memory.ts';
import { SessionRuntime } from '../../runtime.ts';
import { memorySettings } from '../../suggestions/prefs.ts';
import { FakeAgents, until } from '../../test-agent.ts';
import { Workspace } from '../../workspace.ts';
import { ConnectDispatcher } from '../dispatcher.ts';
import { newIdentity, publicIdentity } from '../keys.ts';
import { FakeIdentity, fakeListener, tokensFor } from './connect-fakes.ts';
import { CONNECT_PREFS_KEY, KestrelConnect } from './connect.ts';
import { PhoneChannel } from './phone.ts';
import { HttpConnectService, type ServiceRefusal } from './service.ts';
import { memoryVault } from './vault.ts';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Access tokens the stand-in accepts, each for one account. */
const ACCOUNTS: Record<string, string> = { 'access-0': 'acct-1', 'phone-token': 'acct-1', 'other-token': 'acct-2' };

async function standInRelay(): Promise<{ url: string; carried: string[]; close(): Promise<void> }> {
  const devices = new Map<string, string>(); // device -> account
  const sockets = new Map<string, WebSocket>();
  const carried: string[] = [];
  let n = 0;
  const server: Server = createServer((req, res) => {
    const account = ACCOUNTS[(req.headers.authorization ?? '').replace('Bearer ', '')];
    if (req.url === '/api/v1/config') return void res.end(JSON.stringify({ apiVersion: '0', relay: { path: '/api/v1/relay' }, oidc: { issuer: 'https://id.example.test/realms/kestrel' } }));
    if (req.url === '/api/v1/devices' && req.method === 'POST') {
      if (!account) return void res.writeHead(401).end(JSON.stringify({ statusCode: 401, code: 'sign-in', reason: 'Sign in again.' }));
      const id = `dev-${++n}`;
      devices.set(id, account);
      return void res.writeHead(201).end(JSON.stringify({ device: { id, name: 'x', kind: 'desktop' } }));
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const account = ACCOUNTS[(req.headers.authorization ?? '').replace('Bearer ', '')];
    const device = String(req.headers['kestrel-device'] ?? '');
    const refuse = (status: number, code: string, reason: string) => socket.end(`HTTP/1.1 ${status} No\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${JSON.stringify({ statusCode: status, code, reason })}`);
    if (!account) return refuse(401, 'sign-in', 'That is not a Kestrel Connect sign-in. Sign in again.');
    if (devices.get(device) !== account) return refuse(403, 'unknown-device', 'No such device on this account.');
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.set(device, ws);
      ws.send(JSON.stringify({ service: 'welcome', deviceId: device, limits: {}, signInExpiresAt: new Date(Date.now() + 3_600_000).toISOString() }));
      ws.on('message', (data) => {
        const text = data.toString();
        carried.push(text);
        const to = (JSON.parse(text) as { to?: string }).to ?? '';
        const target = devices.get(to) === account ? sockets.get(to) : undefined;
        if (target) target.send(text);
        else ws.send(JSON.stringify({ service: 'refused', id: null, code: 'unknown-device', reason: 'No such device.' }));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  // The phone's device, registered up front.
  devices.set('phone-dev', 'acct-1');
  return {
    url: `http://127.0.0.1:${port}`,
    carried,
    close: async () => {
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

describe('over real sockets', () => {
  it('the desk links, a phone’s hello crosses the relay and a computer outside the account says so', async () => {
    const relay = await standInRelay();
    cleanup.push(() => relay.close());
    const workspace = new Workspace(memoryPersistence());
    const fake = new FakeAgents();
    const runtime = new SessionRuntime(workspace, { claude: fake.adapter() }, realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-relay-'))));
    const settings = memorySettings();
    await settings.putSetting(CONNECT_PREFS_KEY, JSON.stringify({ enabled: true }));
    const service = new HttpConnectService(relay.url);
    const desk = new KestrelConnect({ vault: memoryVault({ tokens: tokensFor(0, Date.now()), device: null }), identity: new FakeIdentity(), service, settings, computerName: 'Desk', listen: fakeListener().listen, here: 'your Mac', dispatch: (deviceId, send) => new ConnectDispatcher({ workspace, runtime, deviceId, here: 'your Mac', send, keptOff: () => [] }) });
    cleanup.push(() => desk.close());
    await desk.start();
    await until(() => desk.view().link.state === 'connected', 'the desk connects');

    // The phone: its own socket through the same relay.
    const phoneService = new HttpConnectService(relay.url);
    await phoneService.config();
    let phone: PhoneChannel | null = null;
    await new Promise<void>((resolve, reject) => {
      const socket = phoneService.openRelay('phone-token', 'phone-dev', {
        open: () => undefined,
        message: (text) => {
          if (JSON.parse(text).service === 'welcome') {
            phone = new PhoneChannel({ id: 'phone-dev', name: 'Socket phone', identity: newIdentity(), send: (t) => socket.send(t), timeoutMs: 5_000 });
            cleanup.push(() => socket.close(1000));
            resolve();
          } else phone?.receive(text);
        },
        pong: () => undefined,
        refused: reject,
        closed: () => undefined,
        error: reject,
      });
    });
    const p = phone as unknown as PhoneChannel;

    // Letting a device in and the channel that follows are tested end to end in join.test.ts, over the fake
    // service that has the key routes; here the socket path carries a hello and the desk's refusal of a device
    // it does not know, in the clear and in plain words.
    await expect(p.open({ id: desk.device()!.id, signing: publicIdentity(newIdentity()).signing })).rejects.toThrow('cannot take connections until it is let into your account');
    expect(relay.carried.some((t) => t.includes('"session"'))).toBe(true);
  });

  it('a bad token is refused at the upgrade with the service’s words', async () => {
    const relay = await standInRelay();
    cleanup.push(() => relay.close());
    const service = new HttpConnectService(relay.url);
    await service.config();
    const refusal = await new Promise<ServiceRefusal>((resolve) => service.openRelay('nobody', 'dev-1', { open: () => undefined, message: () => undefined, pong: () => undefined, refused: resolve, closed: () => undefined, error: () => undefined }));
    expect(refusal).toMatchObject({ status: 401, code: 'sign-in', message: 'That is not a Kestrel Connect sign-in. Sign in again.' });
  });
});
