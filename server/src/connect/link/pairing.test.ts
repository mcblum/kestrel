// Pairing and the encrypted channel end to end, with no network: the desk's Connect module (its link
// on a fake relay socket, the real dispatcher over a real runtime) and the phone stand-in, with an
// in-memory relay between them that sees, and can change, every frame.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryPersistence } from '../../persistence/memory.ts';
import { SessionRuntime } from '../../runtime.ts';
import { memorySettings } from '../../suggestions/prefs.ts';
import { FakeAgents, until } from '../../test-agent.ts';
import { Workspace } from '../../workspace.ts';
import { ConnectDispatcher } from '../dispatcher.ts';
import { newIdentity, pairingCode, parsePairingCode } from '../keys.ts';
import { connectRoute } from './api.ts';
import { FakeIdentity, FakeService, fakeListener, tokensFor } from './connect-fakes.ts';
import { CONNECT_PREFS_KEY, KestrelConnect } from './connect.ts';
import { PhoneChannel, type PairedDesk } from './phone.ts';
import { memoryVault } from './vault.ts';

const PHONE = 'phone-1';
let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup) await c();
  cleanup = [];
});

async function setup() {
  const workspace = new Workspace(memoryPersistence());
  const fake = new FakeAgents();
  const runtime = new SessionRuntime(workspace, { claude: fake.adapter() }, realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-pair-'))));
  const service = new FakeService();
  const settings = memorySettings();
  await settings.putSetting(CONNECT_PREFS_KEY, JSON.stringify({ enabled: true }));
  const vault = memoryVault({ tokens: tokensFor(0, Date.now()), device: null });
  const desk = new KestrelConnect({
    vault,
    identity: new FakeIdentity(),
    service,
    settings,
    computerName: 'Desk',
    listen: fakeListener().listen,
    here: 'your Mac',
    dispatch: (deviceId, send) => new ConnectDispatcher({ workspace, runtime, deviceId, here: 'your Mac', send }),
  });
  cleanup.push(() => desk.close());
  await desk.start();
  await until(() => service.sockets.length === 1, 'the desk dials');
  const socket = service.last();
  service.welcome(socket, Date.now() + 3_600_000);

  /** What the relay carried from the desk to the phone; `tamper` changes the next phone frame on its way. */
  const carried: string[] = [];
  let tamper: ((frame: Record<string, unknown>) => Record<string, unknown>) | null = null;
  const phone = new PhoneChannel({
    id: PHONE,
    name: 'Test phone',
    identity: newIdentity(),
    timeoutMs: 5_000,
    send: (text) => {
      let out = text;
      if (tamper) {
        out = JSON.stringify(tamper(JSON.parse(text)));
        tamper = null;
      }
      queueMicrotask(() => socket.events.message(out));
    },
  });
  // The desk's socket delivers to the phone, as the relay would.
  const sendFromDesk = socket.send;
  socket.send = (text: string) => {
    sendFromDesk(text);
    carried.push(text);
    queueMicrotask(() => phone.receive(text));
  };
  return { workspace, runtime, fake, desk, phone, vault, carried, socket, tamperNext: (f: typeof tamper) => (tamper = f) };
}

async function paired(): Promise<Awaited<ReturnType<typeof setup>> & { deskKeys: PairedDesk }> {
  const ctx = await setup();
  const offer = ctx.desk.startPairing();
  const deskKeys = await ctx.phone.pair(offer.code);
  await ctx.phone.open(deskKeys);
  return { ...ctx, deskKeys };
}

describe('pairing', () => {
  it('pairs with the code the desk shows, once, and lists the phone', async () => {
    const { desk, phone } = await setup();
    const offer = desk.startPairing();
    expect(desk.view().pairing).toEqual(offer);
    expect(parsePairingCode(offer.code)?.deskId).toBe('device-1');
    const deskKeys = await phone.pair(offer.code);
    expect(deskKeys.id).toBe('device-1');
    expect(desk.view().pairing).toBeNull(); // single use
    expect(desk.view().paired).toEqual([{ id: PHONE, name: 'Test phone', pairedAt: expect.any(Number), connected: false }]);
    await phone.open(deskKeys);
    await until(() => desk.view().paired[0]?.connected === true, 'the channel opens');
  });

  it('refuses a wrong code, and nothing is paired', async () => {
    const { desk, phone } = await setup();
    const offer = desk.startPairing();
    const wrong = pairingCode(parsePairingCode(offer.code)!.deskId, randomBytes(16));
    await expect(phone.pair(wrong)).rejects.toThrow('That pairing code is not the one this computer is showing.');
    expect(desk.view().paired).toEqual([]);
    expect(desk.view().pairing).not.toBeNull(); // the right code still works
  });

  it('refuses when the desk is not pairing', async () => {
    const { desk, phone } = await setup();
    const offer = desk.startPairing();
    desk.stopPairing();
    await expect(phone.pair(offer.code)).rejects.toThrow('your Mac is not pairing right now');
  });

  it('is refused unless the desk is connected', async () => {
    const { desk } = await setup();
    await desk.setEnabled(false);
    expect(() => desk.startPairing()).toThrow('wait until it says Connected');
  });

  it('keeps the paired phone in the protected store', async () => {
    const { vault } = await paired();
    expect(vault.current().paired).toEqual([expect.objectContaining({ id: PHONE, name: 'Test phone' })]);
  });
});

describe('the channel', () => {
  it('carries requests to the dispatcher and back, and the relay sees only ciphertext', async () => {
    const { phone, workspace, runtime, fake, carried } = await paired();
    fake.script = (turn) => {
      fake.hold = true;
      turn.emit({ type: 'needs-input', request: { id: 'ask-1', kind: 'approval', title: 'Run the secret command', detail: 'make', tool: 'Bash', options: [{ id: 'allow', label: 'Allow', role: 'allow' }, { id: 'deny', label: 'Deny', role: 'deny' }] } });
    };
    const session = await runtime.start({ agent: 'claude', projectId: null, prompt: 'deploy the secret project' });
    await until(() => runtime.overlay(session.id)?.messages.some((m) => m.input && !m.input.resolved) ?? false, 'a card');

    const state = await phone.request('state.read', {});
    expect(state).toMatchObject({ ok: true, result: { sessions: [expect.objectContaining({ id: session.id })] } });
    void workspace;
    const read = await phone.request('session.read', { sessionId: session.id });
    expect(read.ok && JSON.stringify(read.result)).toContain('Run the secret command');
    expect(await phone.request('session.answer', { sessionId: session.id, requestId: 'ask-1', optionId: 'allow' })).toEqual({ ok: true, result: { answered: true } });
    expect(await phone.request('session.start', {})).toMatchObject({ ok: false, reason: expect.stringContaining('started at the desk') });

    const relayed = carried.join('\n');
    expect(relayed).not.toContain('secret');
    expect(relayed).not.toContain(session.id);
  });

  it('refuses a tampered frame and drops it; the real phone carries on', async () => {
    const { desk, phone, tamperNext } = await paired();
    tamperNext((frame) => {
      const body = Buffer.from(String(frame.body), 'base64url');
      body.writeUInt8(body.readUInt8(body.length - 1) ^ 1, body.length - 1);
      return { ...frame, body: body.toString('base64url') };
    });
    expect(await phone.request('state.read', {})).toEqual({ ok: false, reason: 'A frame could not be read and was ignored. Try again.' });
    expect(desk.view().paired[0]?.connected).toBe(true);
    expect(await phone.request('state.read', {})).toMatchObject({ ok: true });
  });

  it('refuses a frame replayed by the relay', async () => {
    const { phone, carried } = await paired();
    const frame = phone.sealedRequest('state.read', {});
    phone.sendRaw(frame);
    await until(() => carried.some((t) => t.includes('"replyTo"')), 'the first answer');
    const answers = carried.length;
    phone.sendRaw(frame);
    await until(() => carried.length > answers, 'the second answer');
    expect(JSON.parse(carried.at(-1)!).body).toEqual({ ok: false, reason: 'A frame could not be read and was ignored. Try again.' });
  });

  it('refuses a recorded hello replayed by the relay, and keeps the real channel', async () => {
    const { desk, phone, socket, carried } = await setup();
    const deskKeys = await phone.pair(desk.startPairing().code);
    const sent: string[] = [];
    const deliver = socket.events.message;
    socket.events = { ...socket.events, message: (text: string) => (sent.push(text), deliver(text)) };
    await phone.open(deskKeys);
    const hello = sent.find((t) => t.includes('"session"'))!;
    const before = carried.length;
    socket.events.message(hello);
    await until(() => carried.length > before, 'the desk answers');
    expect(carried.at(-1)).toContain('stale');
    expect(await phone.request('state.read', {})).toMatchObject({ ok: true });
  });

  it('a frame of another protocol version is refused in the clear and never reaches the dispatcher', async () => {
    const { phone, carried } = await paired();
    phone.sendRaw({ v: 99, from: PHONE, to: 'device-1', kind: 'request', id: 'x1', body: { op: 'state.read', args: {} } });
    await until(() => carried.at(-1)?.includes('"replyTo":"x1"') ?? false, 'the refusal');
    expect(JSON.parse(carried.at(-1)!).body).toEqual({ ok: false, reason: expect.stringContaining('Update Kestrel on your Mac') });
  });

  it('a pairing whose name was changed on the way is refused', async () => {
    const { desk, phone, tamperNext } = await setup();
    tamperNext((frame) => ({ ...frame, body: { pair: { ...(frame.body as { pair: object }).pair, name: 'Someone else' } } }));
    await expect(phone.pair(desk.startPairing().code)).rejects.toThrow('That pairing code is not the one');
    expect(desk.view().paired).toEqual([]);
  });

  it('refuses a device that never paired, in plain words and nothing else', async () => {
    const { phone, socket, carried } = await paired();
    const stranger = new PhoneChannel({ id: 'stranger', name: 'x', identity: newIdentity(), timeoutMs: 2_000, send: (t) => queueMicrotask(() => socket.events.message(t)) });
    await expect(stranger.open({ id: 'device-1', keys: { signing: 'x', agreement: 'y' } })).rejects.toThrow();
    expect(carried.at(-1)).toContain('This device is not paired with your Mac');
    void phone;
  });
});

describe('removing a device', () => {
  it('ends its access at once: its channel closes and every later frame is refused', async () => {
    const { desk, phone, deskKeys } = await paired();
    const answer = await connectRoute(['api', 'connect', 'devices', PHONE], 'DELETE', async () => ({}), desk);
    expect(answer).toMatchObject({ status: 200, body: { paired: [] } });
    await until(() => phone.lastBye !== null, 'the phone hears');
    expect(phone.lastBye).toContain('removed');
    await expect(phone.request('state.read', {})).rejects.toThrow('Open the channel first.');
    await expect(phone.open(deskKeys)).rejects.toThrow('This device is not paired with your Mac');
    expect(await connectRoute(['api', 'connect', 'devices', PHONE], 'DELETE', async () => ({}), desk)).toEqual({ status: 409, body: { error: 'That device is not paired with this computer.' } });
  });

  it('a removed phone’s old sealed frame is refused too', async () => {
    const { desk, phone, carried } = await paired();
    const frame = phone.sealedRequest('state.read', {});
    await desk.removeDevice(PHONE);
    const before = carried.length;
    phone.sendRaw(frame);
    await until(() => carried.length > before, 'an answer');
    expect(carried.at(-1)).toContain('This device is not paired with your Mac');
  });
});
