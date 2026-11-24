// Letting a device into the account and the encrypted channel end to end, with no network: the desk's
// Connect module (its link on a fake relay socket, the real dispatcher over a real runtime), a phone
// stand-in that keeps the account key the way the iPhone app does (the same AccountKeys and AccountJoin),
// and an in-memory relay between them that sees, and can change, every frame (account stage 1, protocol 3).
import { connectLists } from '../lists.ts';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter } from '../../agents/types.ts';
import { memoryPersistence } from '../../persistence/memory.ts';
import { SessionRuntime } from '../../runtime.ts';
import { memorySettings } from '../../suggestions/prefs.ts';
import { FakeAgents, until } from '../../test-agent.ts';
import { Workspace } from '../../workspace.ts';
import { ConnectDispatcher } from '../dispatcher.ts';
import { newIdentity, newJoinNonce, publicIdentity, signJoinWelcome, type Identity } from '../keys.ts';
import { AccountKeys, type KeysTrust } from './account-keys.ts';
import { connectRoute } from './api.ts';
import { FakeIdentity, FakeService, fakeListener, tokensFor, type FakeSocket } from './connect-fakes.ts';
import { CONNECT_PREFS_KEY, KestrelConnect } from './connect.ts';
import { HeldApi } from './held-api.ts';
import { AccountJoin } from './join.ts';
import { JoinApi } from './join-api.ts';
import { PhoneChannel, type KnownDesk } from './phone.ts';
import { memoryVault } from './vault.ts';
import { pushSource } from './push.ts';
import { heldSource } from './held.ts';
import { memoryQueueStore } from './held-queue.ts';
import { sealRecord } from '../account-key.ts';
import { createProject } from '../../project-store.ts';
import { keptOffWith, type ConnectJoinRequest } from '../../shared/connect.ts';

const PHONE = 'phone-1';
let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup) await c();
  cleanup = [];
});

/** The relay: every frame goes to the device named in `to`; `tamper` changes the next phone frame on its way. */
function relay(service: FakeService) {
  const carried: string[] = [];
  const phones = new Map<string, (text: string) => void>();
  const lost: Array<(text: string) => boolean> = [];
  const wired = new Set<FakeSocket>();
  const deliver = (text: string) => {
    const to = (JSON.parse(text) as { to?: string }).to ?? '';
    const phone = phones.get(to);
    if (phone) return queueMicrotask(() => phone(text));
    const socket = [...service.sockets].reverse().find((s) => s.deviceId === to && s.closedWith === null);
    if (socket) queueMicrotask(() => socket.events.message(text));
  };
  /** Wires and welcomes every socket the desks opened since the last call. */
  const wire = () => {
    for (const socket of service.sockets) {
      if (wired.has(socket)) continue;
      wired.add(socket);
      const send = socket.send;
      socket.send = (text: string) => {
        send(text);
        carried.push(text);
        if (!lost.some((l) => l(text))) deliver(text);
      };
      service.welcome(socket, Date.now() + 3_600_000);
    }
  };
  return { carried, phones, wire, deliver, lose: (l: (text: string) => boolean) => lost.push(l) };
}

type Relay = ReturnType<typeof relay>;

/** Claude, Codex and OpenCode, each a fake adapter under its own name. */
function agents(fake: FakeAgents): Record<'claude' | 'codex' | 'opencode', AgentAdapter> {
  return { claude: fake.adapter(), codex: { ...fake.adapter(), agent: 'codex' }, opencode: { ...fake.adapter(), agent: 'opencode' } } as Record<'claude' | 'codex' | 'opencode', AgentAdapter>;
}

async function newDesk(service: FakeService, wires: Relay, name = 'Desk') {
  const workspace = new Workspace(memoryPersistence());
  const fake = new FakeAgents();
  const runtime = new SessionRuntime(workspace, agents(fake), realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-join-'))));
  const settings = memorySettings();
  await settings.putSetting(CONNECT_PREFS_KEY, JSON.stringify({ enabled: true }));
  const vault = memoryVault({ tokens: tokensFor(0, Date.now()), device: null });
  const here = name === 'Desk' ? 'your Mac' : name;
  const desk = new KestrelConnect({
    vault,
    identity: new FakeIdentity(),
    service,
    settings,
    computerName: name,
    listen: fakeListener().listen,
    here,
    dispatch: (deviceId, send) => new ConnectDispatcher({ workspace, runtime, deviceId, here, send }),
    held: { source: heldSource(workspace, runtime, connectLists(runtime.reviewPrefs, null, null)), queue: memoryQueueStore() },
    push: { source: pushSource(workspace, runtime, null, null) },
  });
  cleanup.push(() => desk.close());
  const count = service.sockets.length;
  await desk.start();
  await until(() => service.sockets.length > count, 'the desk dials');
  wires.wire();
  await until(() => desk.view().link.state === 'connected', 'the desk connects');
  return { workspace, runtime, fake, settings, vault, desk, socket: service.last(), id: () => desk.device()!.id };
}

/** The phone stand-in: its channel, and the key and joining it keeps as the iPhone app does. */
async function newPhone(service: FakeService, wires: Relay, id = PHONE, tamper?: { next: ((frame: Record<string, unknown>) => Record<string, unknown>) | null }) {
  const identity: Identity = newIdentity();
  service.held.addDevice(id, 'Test phone', 'phone');
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) => service.call(`token-${id}`, id, method, path, body);
  let trust: KeysTrust | null = null;
  const keys = new AccountKeys({
    api: () => new HeldApi(call),
    me: () => ({ id, name: 'Test phone', kind: 'phone', identity }),
    trust: () => trust,
    saveTrust: async (next) => void (trust = next),
    changed: () => undefined,
  });
  const channel = new PhoneChannel({
    id,
    name: 'Test phone',
    identity,
    timeoutMs: 5_000,
    send: (text) => {
      let out = text;
      if (tamper?.next) {
        out = JSON.stringify(tamper.next(JSON.parse(text)));
        tamper.next = null;
      }
      wires.deliver(out);
    },
  });
  const joining = new AccountJoin({
    api: () => new JoinApi(call),
    me: () => ({ id, name: 'Test phone', kind: 'phone', identity }),
    keys,
    hello: (to, body) => channel.sendHello(to, body),
    changed: () => undefined,
  });
  channel.onJoin((from, body) => joining.receive(from, body));
  wires.phones.set(id, (text) => channel.receive(text));
  await new JoinApi(call).putKeys(publicIdentity(identity));
  return { id, identity, keys, channel, joining };
}

type Desk = Awaited<ReturnType<typeof newDesk>>;
type Phone = Awaited<ReturnType<typeof newPhone>>;

/** The six digits the new device shows. */
const codeOn = (j: AccountJoin): string => {
  const view = j.joining();
  if (view?.state !== 'code') throw new Error(`no code is shown (${view?.state ?? 'nothing'})`);
  return view.code;
};

/** The second code the approving device shows for a request it let in (step 8a). */
const secondOn = (requests: ConnectJoinRequest[], id: string): string => {
  const request = requests.find((r) => r.id === id);
  if (request?.state !== 'showing' || !request.code) throw new Error(`no second code is shown (${request?.state ?? 'no request'})`);
  return request.code;
};

/** The phone asks, the person opens its request on the desk and types the code; the phone is shown who let it in. */
async function phoneAsksDesk(desk: Desk, phone: Phone): Promise<string> {
  await phone.joining.ask();
  await until(() => desk.desk.view().requests.length === 1, 'the desk hears of the request');
  const request = desk.desk.view().requests[0]!;
  expect(request).toMatchObject({ name: 'Test phone', kind: 'phone', state: 'waiting' });
  await desk.desk.openRequest(request.id);
  await until(() => phone.joining.joining()?.state === 'code', 'the phone shows a code');
  await until(() => desk.desk.view().requests[0]?.state === 'typing', 'the desk asks for the code');
  return request.id;
}

/** The desk dials again after its socket dropped; the relay wires the new socket. */
function relinker(service: FakeService, wires: Relay) {
  return async (lose?: (text: string) => boolean) => {
    if (lose) wires.lose(lose);
    const count = service.sockets.length;
    await until(() => service.sockets.length > count, 'the desk dials again');
    wires.wire();
  };
}

/** The desk alone: the account's first device. */
async function alone() {
  const service = new FakeService();
  const wires = relay(service);
  const d = await newDesk(service, wires);
  await until(() => d.desk.keys.ready() !== null, 'the account key is made');
  return { ...d, service, wires, carried: wires.carried, relinked: relinker(service, wires) };
}

/** The desk is the account's first device; the phone is let in by it and opens a channel to it. */
async function joined() {
  const service = new FakeService();
  const wires = relay(service);
  const tamper = { next: null as ((frame: Record<string, unknown>) => Record<string, unknown>) | null };
  const desk = await newDesk(service, wires);
  await until(() => desk.desk.keys.ready() !== null, 'the account key is made');
  const phone = await newPhone(service, wires, PHONE, tamper);
  const id = await phoneAsksDesk(desk, phone);
  await desk.desk.typeCode(id, codeOn(phone.joining));
  await until(() => phone.joining.joining()?.state === 'confirm', 'the phone asks for the second code');
  await phone.joining.confirm(secondOn(desk.desk.view().requests, id));
  expect(phone.joining.joining()).toEqual({ state: 'in', by: 'Desk' });
  const deskKeys: KnownDesk = { id: desk.id(), signing: phone.keys.member(desk.id())! };
  await phone.channel.open(deskKeys);
  return { ...desk, service, wires, phone: phone.channel, member: phone, deskKeys, carried: wires.carried, relinked: relinker(service, wires), tamperNext: (f: typeof tamper.next) => (tamper.next = f) };
}

describe('letting a phone in', () => {
  it('the desk types the code the phone shows, and the phone keeps the key once the person says yes', async () => {
    const t = await joined();
    expect(t.member.keys.ready()!.adk.equals(t.desk.keys.ready()!.adk)).toBe(true);
    await until(() => t.desk.view().devices.find((d) => d.id === PHONE)?.connected === true, 'the channel opens');
    expect(t.desk.view().devices).toEqual(expect.arrayContaining([expect.objectContaining({ id: PHONE, name: 'Test phone', inAccount: true })]));
    // The phone said it joined: the desk says so until Done (step 8c).
    await until(() => t.desk.view().requests[0]?.state === 'done', 'the desk hears the phone joined');
    expect(t.desk.view().requests).toEqual([expect.objectContaining({ name: 'Test phone', state: 'done', code: null, outcome: 'Test phone is in your account.' })]);
    t.desk.dismissRequest(t.desk.view().requests[0]!.id);
    expect(t.desk.view().requests).toEqual([]);
    expect(t.service.held.keyring!.version).toBe(2);
  });

  it('a wrong code is refused with tries left, and the right one still works', async () => {
    const service = new FakeService();
    const wires = relay(service);
    const desk = await newDesk(service, wires);
    await until(() => desk.desk.keys.ready() !== null, 'the account key is made');
    const phone = await newPhone(service, wires);
    const id = await phoneAsksDesk(desk, phone);
    const right = codeOn(phone.joining).replace(/\D/g, '');
    const wrong = right === '000000' ? '000001' : '000000';
    await expect(desk.desk.typeCode(id, wrong)).rejects.toThrow('2 tries left');
    expect(desk.desk.view().requests[0]).toMatchObject({ wrong: 1, problem: expect.stringContaining('not the code') });
    await desk.desk.typeCode(id, right);
    await until(() => phone.joining.joining()?.state === 'confirm', 'the welcome');
  });

  it('three wrong codes refuse the request, and the phone is told', async () => {
    const service = new FakeService();
    const wires = relay(service);
    const desk = await newDesk(service, wires);
    await until(() => desk.desk.keys.ready() !== null, 'the account key is made');
    const phone = await newPhone(service, wires);
    const id = await phoneAsksDesk(desk, phone);
    const wrong = codeOn(phone.joining).replace(/\D/g, '') === '000000' ? '000001' : '000000';
    await expect(desk.desk.typeCode(id, wrong)).rejects.toThrow();
    await expect(desk.desk.typeCode(id, wrong)).rejects.toThrow();
    await expect(desk.desk.typeCode(id, wrong)).rejects.toThrow('third wrong code');
    await until(() => phone.joining.joining()?.state === 'ended', 'the phone hears');
    expect(phone.joining.joining()).toMatchObject({ reason: expect.stringContaining('Three wrong codes') });
    expect(service.held.copies.has(PHONE)).toBe(false);
    expect(service.held.joins.size).toBe(0);
  });

  it('Not me refuses it, and nothing is given', async () => {
    const service = new FakeService();
    const wires = relay(service);
    const desk = await newDesk(service, wires);
    await until(() => desk.desk.keys.ready() !== null, 'the account key is made');
    const phone = await newPhone(service, wires);
    await phone.joining.ask();
    await until(() => desk.desk.view().requests.length === 1, 'the request');
    const answer = await connectRoute(['api', 'connect', 'requests', desk.desk.view().requests[0]!.id, 'refuse'], 'POST', async () => ({}), desk.desk);
    expect(answer).toMatchObject({ status: 200, body: { requests: [] } });
    expect(service.held.copies.has(PHONE)).toBe(false);
  });

  it('a relay that swaps the phone’s reveal is caught by the commitment, and nothing is given', async () => {
    const service = new FakeService();
    const wires = relay(service);
    const tamper = { next: null as ((frame: Record<string, unknown>) => Record<string, unknown>) | null };
    const desk = await newDesk(service, wires);
    await until(() => desk.desk.keys.ready() !== null, 'the account key is made');
    const phone = await newPhone(service, wires, PHONE, tamper);
    await phone.joining.ask();
    await until(() => desk.desk.view().requests.length === 1, 'the request');
    const swapped = publicIdentity(newIdentity());
    tamper.next = (frame) => {
      const body = frame.body as { join: Record<string, unknown> };
      return { ...frame, body: { join: { ...body.join, keys: swapped } } };
    };
    await desk.desk.openRequest(desk.desk.view().requests[0]!.id);
    await until(() => desk.desk.view().requests.length === 0, 'the request is refused');
    expect(service.held.copies.has(PHONE)).toBe(false);
  });

  it('a second device that opens the request is told it is taken', async () => {
    const service = new FakeService();
    const wires = relay(service);
    const desk = await newDesk(service, wires);
    await until(() => desk.desk.keys.ready() !== null, 'the account key is made');
    const other = await newDesk(service, wires, 'Mac mini');
    const phone = await newPhone(service, wires);
    // The Mac mini is let in first, by the desk.
    const miniId = await (async () => {
      await until(() => desk.desk.view().requests.length === 1, 'the Mac mini asks on its own');
      const id = desk.desk.view().requests[0]!.id;
      await desk.desk.openRequest(id);
      await until(() => other.desk.view().joining?.state === 'code', 'the Mac mini shows a code');
      await desk.desk.typeCode(id, (other.desk.view().joining as { code: string }).code);
      await until(() => other.desk.view().joining?.state === 'confirm', 'the Mac mini asks');
      await other.desk.confirmJoin(secondOn(desk.desk.view().requests, id));
      return other.id();
    })();
    expect(other.desk.view().keys.state).toBe('ready');
    await phone.joining.ask();
    const waiting = (d: Desk) => d.desk.view().requests.filter((r) => r.state !== 'showing' && r.state !== 'done');
    await until(() => waiting(desk).length === 1 && waiting(other).length === 1, 'both hear');
    const id = waiting(desk)[0]!.id;
    await desk.desk.openRequest(id);
    await until(() => phone.joining.joining()?.state === 'code', 'the phone revealed to the desk');
    await other.desk.openRequest(id);
    await until(() => other.desk.view().requests[0]?.state === 'waiting' && other.desk.view().requests[0]?.problem !== null, 'the Mac mini is told');
    expect(other.desk.view().requests[0]!.problem).toContain('already being let in');
    void miniId;
  });

  it('a welcome from a device the phone did not reveal to is ignored', async () => {
    const service = new FakeService();
    const wires = relay(service);
    const desk = await newDesk(service, wires);
    await until(() => desk.desk.keys.ready() !== null, 'the account key is made');
    const phone = await newPhone(service, wires);
    await phoneAsksDesk(desk, phone);
    const request = phone.joining.joining();
    phone.joining.receive('stranger', { step: 'welcome', id: service.held.joins.keys().next().value, generation: 1, keyringVersion: 2, signature: 'x'.repeat(86) });
    expect(phone.joining.joining()).toEqual(request);
  });

  it('the second code: a wrong one leaves tries, three discard the key, and nothing is kept', async () => {
    const service = new FakeService();
    const wires = relay(service);
    const desk = await newDesk(service, wires);
    await until(() => desk.desk.keys.ready() !== null, 'the account key is made');
    const phone = await newPhone(service, wires);
    const id = await phoneAsksDesk(desk, phone);
    await desk.desk.typeCode(id, codeOn(phone.joining));
    await until(() => phone.joining.joining()?.state === 'confirm', 'the phone asks');
    const second = secondOn(desk.desk.view().requests, id);
    const wrong = second.replace(/\D/g, '') === '000000' ? '000001' : '000000';
    await expect(phone.joining.confirm(wrong)).rejects.toThrow('2 tries left');
    expect(phone.joining.joining()).toMatchObject({ state: 'confirm', by: 'Desk', wrong: 1 });
    await expect(phone.joining.confirm(wrong)).rejects.toThrow('1 try left');
    await expect(phone.joining.confirm(wrong)).rejects.toThrow('did not keep the key');
    expect(phone.keys.ready()).toBeNull();
    // Step 8b: the phone deleted its copy, told the desk, and the desk withdrew it from the keyring without a rotation.
    expect(service.held.copies.has(PHONE)).toBe(false);
    await until(() => service.held.withdrawn.includes(PHONE), 'the desk withdraws the phone');
    await until(() => desk.desk.keys.member(PHONE) === null, 'the desk no longer trusts the phone');
    expect(service.held.generation).toBe(1);
    await until(() => desk.desk.view().requests[0]?.state === 'done', 'the desk says what happened');
    expect(desk.desk.view().requests[0]!.outcome).toBe('Test phone was not let in: the second code typed there was wrong.');
    expect(phone.joining.joining()).toMatchObject({ state: 'ended', reason: expect.stringContaining('someone has your sign-in') });
    await expect(phone.joining.confirm(second)).rejects.toThrow('Nothing is waiting');
    // It can ask again from the start.
    await phone.joining.ask();
    expect(phone.joining.joining()).toMatchObject({ state: 'asking' });
  });

  it('cancelling at the second code keeps nothing; the desk stops showing it when told', async () => {
    const service = new FakeService();
    const wires = relay(service);
    const desk = await newDesk(service, wires);
    await until(() => desk.desk.keys.ready() !== null, 'the account key is made');
    const phone = await newPhone(service, wires);
    const id = await phoneAsksDesk(desk, phone);
    await desk.desk.typeCode(id, codeOn(phone.joining));
    await until(() => phone.joining.joining()?.state === 'confirm', 'the phone asks');
    await phone.joining.cancel();
    expect(phone.keys.ready()).toBeNull();
    expect(phone.joining.joining()).toMatchObject({ state: 'ended' });
    await until(() => desk.desk.view().requests[0]?.outcome === 'Test phone was not let in: it was cancelled there.', 'the desk hears');
    await until(() => service.held.withdrawn.includes(PHONE), 'withdrawn');
    const answer = await connectRoute(['api', 'connect', 'requests', id, 'dismiss'], 'POST', async () => ({}), desk.desk);
    expect(answer).toMatchObject({ status: 200, body: { requests: [] } });
  });

  it('a relay that plays the approver gets as far as a welcome, and no further: the phone waits for a code nobody showed the person', async () => {
    const service = new FakeService();
    const wires = relay(service);
    const desk = await newDesk(service, wires);
    await until(() => desk.desk.keys.ready() !== null, 'the account key is made');
    const phone = await newPhone(service, wires);
    await phone.joining.ask();
    const id = [...service.held.joins.keys()][0]!;
    // The relay opens the request itself, works out the first code (it has both nonces) and welcomes with its own key.
    const rogue = newIdentity();
    const rogueNonce = newJoinNonce();
    const sent: Record<string, unknown>[] = [];
    wires.phones.set('rogue', (text) => sent.push(JSON.parse(text)));
    phone.joining.receive('rogue', { step: 'open', id, nonce: rogueNonce.toString('base64url'), keys: publicIdentity(rogue), name: 'Desk' });
    await until(() => sent.length === 1, 'the phone reveals to whoever opened first');
    const signature = signJoinWelcome(rogue, id, PHONE, 'rogue', publicIdentity(phone.identity), 1, 2);
    phone.joining.receive('rogue', { step: 'welcome', id, generation: 1, keyringVersion: 2, signature });
    expect(phone.joining.joining()).toMatchObject({ state: 'confirm', by: 'Desk' });
    // The person's own desk never opened this request, so it shows no second code to type.
    expect(desk.desk.view().requests.find((r) => r.id === id)?.state).toBe('waiting');
    await expect(phone.joining.confirm('000000')).rejects.toThrow('2 tries left');
    expect(phone.keys.ready()).toBeNull();
  });
});

describe('a grant the new device did not keep (step 8b)', () => {
  it('a declined that the phone did not sign is ignored, and nothing is withdrawn', async () => {
    const service = new FakeService();
    const wires = relay(service);
    const desk = await newDesk(service, wires);
    await until(() => desk.desk.keys.ready() !== null, 'the account key is made');
    const phone = await newPhone(service, wires);
    const id = await phoneAsksDesk(desk, phone);
    await desk.desk.typeCode(id, codeOn(phone.joining));
    await until(() => phone.joining.joining()?.state === 'confirm', 'the phone asks');
    wires.deliver(JSON.stringify({ v: 3, from: PHONE, to: desk.id(), kind: 'hello', id: 'forged', body: { join: { step: 'declined', id, reason: 'cancelled', signature: 'A'.repeat(86) } } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(desk.desk.view().requests[0]).toMatchObject({ state: 'showing' });
    expect(service.held.withdrawn).toEqual([]);
  });

  it('with the desk away, the phone’s discarded copy is withdrawn at the desk’s next sync', async () => {
    const service = new FakeService();
    const wires = relay(service);
    const desk = await newDesk(service, wires);
    await until(() => desk.desk.keys.ready() !== null, 'the account key is made');
    const phone = await newPhone(service, wires);
    const id = await phoneAsksDesk(desk, phone);
    await desk.desk.typeCode(id, codeOn(phone.joining));
    await until(() => phone.joining.joining()?.state === 'confirm', 'the phone asks');
    wires.lose(() => true); // the desk hears nothing more
    wires.phones.delete(PHONE);
    await phone.joining.cancel();
    expect(service.held.copies.has(PHONE)).toBe(false);
    expect(service.held.withdrawn).toEqual([]);
    await desk.desk.keys.sync();
    expect(service.held.withdrawn).toEqual([PHONE]);
    expect(service.held.generation).toBe(1);
  });

  it('a computer closed part-way through comes back out of the account and asks again', async () => {
    const service = new FakeService();
    const wires = relay(service);
    const phone = await newPhone(service, wires);
    const first = await newDesk(service, wires);
    await until(() => first.desk.keys.ready() !== null, 'the account key is made');
    const mini = await newDesk(service, wires, 'Mac mini');
    await until(() => first.desk.view().requests.length === 1, 'the Mac mini asks');
    const id = first.desk.view().requests[0]!.id;
    await first.desk.openRequest(id);
    await until(() => mini.desk.view().joining?.state === 'code', 'a code');
    await first.desk.typeCode(id, (mini.desk.view().joining as { code: string }).code);
    await until(() => mini.desk.view().joining?.state === 'confirm', 'the Mac mini asks for the second code');
    expect(service.held.copies.has(mini.id())).toBe(true);
    // Closed before the second code was typed: what it was told is gone; it starts again from what the service holds.
    await mini.desk.close();
    const again = new KestrelConnect({ vault: mini.vault, identity: new FakeIdentity(), service, settings: mini.settings, computerName: 'Mac mini', listen: fakeListener().listen, here: 'Mac mini', dispatch: () => null as never });
    cleanup.push(() => again.close());
    const count = service.sockets.length;
    await again.start();
    await until(() => service.sockets.length > count, 'it dials');
    wires.wire();
    await until(() => !service.held.copies.has(mini.id()), 'it deletes the copy it cannot open');
    await until(() => again.view().joining?.state === 'asking', 'it asks again');
    expect(again.view().keys.state).toBe('locked');
    await first.desk.keys.sync();
    expect(service.held.withdrawn).toContain(mini.id());
    void phone;
  });
});

describe('letting a computer in', () => {
  it('a new computer asks on its own when it finds an account key it does not hold, and is let in by the phone', async () => {
    const service = new FakeService();
    const wires = relay(service);
    const first = await newDesk(service, wires);
    await until(() => first.desk.keys.ready() !== null, 'the account key is made');
    const phone = await newPhone(service, wires);
    const id = await phoneAsksDesk(first, phone);
    await first.desk.typeCode(id, codeOn(phone.joining));
    await until(() => phone.joining.joining()?.state === 'confirm', 'the phone asks');
    await phone.joining.confirm(secondOn(first.desk.view().requests, id));

    const mini = await newDesk(service, wires, 'Mac mini');
    await until(() => mini.desk.view().joining?.state === 'asking', 'the Mac mini asks to join');
    expect(mini.desk.view().keys.state).toBe('locked');
    await phone.joining.refresh();
    const request = phone.joining.requests().find((r) => r.name === 'Mac mini')!;
    phone.joining.open(request.id);
    await until(() => mini.desk.view().joining?.state === 'code', 'the Mac mini shows a code');
    await phone.joining.type(request.id, (mini.desk.view().joining as { code: string }).code);
    await until(() => mini.desk.view().joining?.state === 'confirm', 'the Mac mini asks');
    expect(mini.desk.view().joining).toEqual({ state: 'confirm', by: 'Test phone', wrong: 0, problem: null });
    const second = secondOn(phone.joining.requests(), request.id);
    const answer = await connectRoute(['api', 'connect', 'join', 'confirm'], 'POST', async () => ({ code: second }), mini.desk);
    expect(answer).toMatchObject({ status: 200, body: { keys: { state: 'ready' }, joining: { state: 'in', by: 'Test phone' } } });

    // The phone reaches the new computer, which knows it from the keyring.
    await phone.keys.sync();
    await phone.channel.open({ id: mini.id(), signing: phone.keys.member(mini.id())! });
    expect(await phone.channel.request('state.read', {})).toMatchObject({ ok: true });
  });

  it('a computer not yet in the account takes no connections', async () => {
    const service = new FakeService();
    const wires = relay(service);
    const first = await newDesk(service, wires);
    await until(() => first.desk.keys.ready() !== null, 'the account key is made');
    const mini = await newDesk(service, wires, 'Mac mini');
    const phone = await newPhone(service, wires);
    await expect(phone.channel.open({ id: mini.id(), signing: publicIdentity(newIdentity()).signing })).rejects.toThrow('Mac mini cannot take connections until it is let into your account');
  });

  it('the join routes refuse what does not fit', async () => {
    const service = new FakeService();
    const wires = relay(service);
    const desk = await newDesk(service, wires);
    await until(() => desk.desk.keys.ready() !== null, 'the account key is made');
    const route = (parts: string[], body: Record<string, unknown> = {}) => connectRoute(['api', 'connect', ...parts], 'POST', async () => body, desk.desk);
    expect(await route(['join'])).toEqual({ status: 409, body: { error: 'This computer is in your account already.' } });
    expect(await route(['join', 'confirm'], { code: 123456 })).toMatchObject({ status: 400 });
    expect(await route(['join', 'confirm'], { code: '123456' })).toEqual({ status: 409, body: { error: 'Nothing is waiting to be confirmed.' } });
    expect(await route(['join', 'cancel'])).toEqual({ status: 409, body: { error: 'Nothing is waiting to be confirmed.' } });
    expect(await route(['requests', 'nope', 'dismiss'])).toMatchObject({ status: 409 });
    expect(await route(['requests', 'nope', 'open'])).toMatchObject({ status: 409, body: { error: expect.stringContaining('has ended') } });
    expect(await route(['requests', 'nope', 'code'], {})).toMatchObject({ status: 400 });
  });
});

describe('the channel', () => {
  it('carries requests to the dispatcher and back, and the relay sees only ciphertext', async () => {
    const { phone, workspace, runtime, fake, carried } = await joined();
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
    const { desk, phone, tamperNext } = await joined();
    tamperNext((frame) => {
      const body = Buffer.from(String(frame.body), 'base64url');
      body.writeUInt8(body.readUInt8(body.length - 1) ^ 1, body.length - 1);
      return { ...frame, body: body.toString('base64url') };
    });
    expect(await phone.request('state.read', {})).toEqual({ ok: false, reason: 'A frame could not be read and was ignored. Try again.' });
    expect(desk.view().devices.find((d) => d.id === PHONE)?.connected).toBe(true);
    expect(await phone.request('state.read', {})).toMatchObject({ ok: true });
  });

  it('refuses a frame replayed by the relay', async () => {
    const { phone, carried } = await joined();
    const frame = phone.sealedRequest('state.read', {});
    phone.sendRaw(frame);
    await until(() => carried.some((t) => t.includes('"replyTo"')), 'the first answer');
    const answers = carried.length;
    phone.sendRaw(frame);
    await until(() => carried.length > answers, 'the second answer');
    expect(JSON.parse(carried.at(-1)!).body).toEqual({ ok: false, reason: 'A frame could not be read and was ignored. Try again.' });
  });

  it('refuses a recorded hello replayed by the relay, and keeps the real channel', async () => {
    const t = await joined();
    let hello: Record<string, unknown> | null = null;
    t.tamperNext((frame) => ((hello = frame), frame));
    await t.phone.open(t.deskKeys);
    const before = t.carried.length;
    t.wires.deliver(JSON.stringify(hello));
    await until(() => t.carried.length > before, 'the desk answers');
    expect(t.carried.at(-1)).toContain('stale');
    expect(await t.phone.request('state.read', {})).toMatchObject({ ok: true });
  });

  it('a frame of another protocol version is refused in the clear and never reaches the dispatcher', async () => {
    const { phone, carried } = await joined();
    phone.sendRaw({ v: 99, from: PHONE, to: 'device-1', kind: 'request', id: 'x1', body: { op: 'state.read', args: {} } });
    await until(() => carried.at(-1)?.includes('"replyTo":"x1"') ?? false, 'the refusal');
    expect(JSON.parse(carried.at(-1)!).body).toEqual({ ok: false, reason: expect.stringContaining('Update Kestrel on your Mac') });
  });

  it('refuses a device that is not in the account, in plain words and nothing else', async () => {
    const t = await joined();
    const stranger = new PhoneChannel({ id: 'stranger', name: 'x', identity: newIdentity(), timeoutMs: 2_000, send: (text) => t.wires.deliver(text) });
    t.wires.phones.set('stranger', (text) => stranger.receive(text));
    await expect(stranger.open({ id: t.id(), signing: publicIdentity(newIdentity()).signing })).rejects.toThrow('Your Mac does not know this device');
    const sealed = t.phone.sealedRequest('state.read', {});
    stranger.sendRaw({ ...sealed, from: 'stranger' });
    await until(() => t.carried.at(-1)?.includes('"to":"stranger"') ?? false, 'the refusal');
    expect(t.carried.at(-1)).toContain('does not know this device');
  });

  it('runs a Claude, a Codex and an OpenCode session’s card from the phone', async () => {
    const t = await joined();
    t.fake.script = (turn) => {
      t.fake.hold = true;
      turn.emit({ type: 'needs-input', request: { id: 'ask-1', kind: 'approval', title: 'Run it', detail: 'make', tool: 'Bash', options: [{ id: 'allow', label: 'Allow', role: 'allow' }, { id: 'deny', label: 'Deny', role: 'deny' }] } });
    };
    for (const agent of ['claude', 'codex', 'opencode'] as const) {
      const session = await t.runtime.start({ agent, projectId: null, prompt: `work in ${agent}` });
      await until(() => t.runtime.overlay(session.id)?.messages.some((m) => m.input && !m.input.resolved) ?? false, `a ${agent} card`);
      const state = await t.phone.request('state.read', {});
      expect(state).toMatchObject({ ok: true, result: { sessions: expect.arrayContaining([expect.objectContaining({ id: session.id, agent })]) } });
      expect(await t.phone.request('session.answer', { sessionId: session.id, requestId: 'ask-1', optionId: 'allow' })).toEqual({ ok: true, result: { answered: true } });
    }
  });
});

describe('the desk’s link drops under a live phone channel', () => {
  // 2026-11-23: an edge restart closed the desk's socket (1006). The desk drops every channel with its
  // link; when it is back it tells each phone to say hello again, and the phone reads the state anew.
  it('the phone is told to say hello again when the desk is back, and then reads the state', async () => {
    const { phone, socket, relinked, desk, runtime, carried } = await joined();
    const session = await runtime.start({ agent: 'claude', projectId: null, prompt: 'write the release notes' });
    expect(await phone.request('session.watch', { sessionId: session.id })).toMatchObject({ ok: true });
    socket.events.closed(1006, '');
    expect(desk.view().devices.find((d) => d.id === PHONE)?.connected).not.toBe(true);
    await relinked();
    await until(() => phone.reopening !== null, 'the desk tells the phone');
    expect(phone.lastBye).toContain('Say hello again');
    await phone.reopening;
    expect(desk.view().devices.find((d) => d.id === PHONE)?.connected).toBe(true);
    const state = await phone.request('state.read', {});
    expect(state).toMatchObject({ ok: true, result: { sessions: [expect.objectContaining({ id: session.id })] } });
    // Nothing sealed under the old channel crossed the new socket: the first frame after it is the bye.
    const afterDrop = carried.slice(carried.findIndex((t) => t.includes('"again":true')));
    expect(JSON.parse(afterDrop[0]!)).toMatchObject({ kind: 'bye', body: { again: true } });
  });

  it('a request on a channel the desk no longer has is answered, and the phone is told to say hello again', async () => {
    const { phone, socket, relinked } = await joined();
    socket.events.closed(1006, '');
    // The bye the desk sends when it is back is lost on the way: the phone still holds its old channel.
    let lostOne = false;
    await relinked((text) => !lostOne && text.includes('"again":true') && (lostOne = true));
    expect(lostOne).toBe(true);
    expect(await phone.request('state.read', {})).toEqual({ ok: false, reason: 'Say hello again first: the connection to this computer was renewed.' });
    await until(() => phone.reopening !== null, 'the desk tells the phone');
    await phone.reopening;
    expect(await phone.request('state.read', {})).toMatchObject({ ok: true });
  });
});

describe('a phone comes back on a new socket (2026-11-24: the Mac shows offline for up to a minute)', () => {
  /** Frames the desk sent to the phone after `from` (an index into `carried`). */
  const toPhone = (carried: string[], from: number) => carried.slice(from).map((t) => JSON.parse(t) as { from: string; to: string; kind: string; body: unknown }).filter((f) => f.to === PHONE);

  it('a hello on the new socket, while the desk still holds the old channel, is answered with one hello and at once', async () => {
    const { phone, deskKeys, carried, desk } = await joined();
    // The phone was put away and opened again: its relay socket is new, and it says hello with fresh keys.
    const before = carried.length;
    const started = performance.now();
    await phone.open(deskKeys);
    const helloMs = performance.now() - started;
    expect(toPhone(carried, before).map((f) => [f.kind, Object.keys(f.body as object)])).toEqual([['hello', ['session']]]);
    expect(desk.view().devices.find((d) => d.id === PHONE)?.connected).toBe(true);
    const asked = performance.now();
    expect(await phone.request('state.read', {})).toMatchObject({ ok: true });
    const stateMs = performance.now() - asked;
    // Nothing waits on a timer: both are one turn of the desk's event loop.
    expect(helloMs).toBeLessThan(100);
    expect(stateMs).toBeLessThan(100);
  });

  it('a request on the old channel from the new socket needs no hello: the channel does not belong to a socket', async () => {
    const { phone, carried } = await joined();
    const before = carried.length;
    expect(await phone.request('state.read', {})).toMatchObject({ ok: true });
    expect(toPhone(carried, before).map((f) => f.kind)).toEqual(['response']);
  });

  it('a hello replayed or sent twice is refused as stale in one hello frame, and the next fresh hello is taken at once', async () => {
    const { phone, deskKeys, carried, tamperNext } = await joined();
    let replay: Record<string, unknown> | null = null;
    tamperNext((frame) => (replay = frame));
    await phone.open(deskKeys);
    const before = carried.length;
    phone.sendRaw(replay!);
    await until(() => toPhone(carried, before).length > 0, 'an answer');
    expect(toPhone(carried, before).map((f) => [f.kind, f.body])).toEqual([['hello', { refused: 'That connection request is stale. Check the clock on this device and connect again.' }]]);
    await phone.open(deskKeys);
    expect(await phone.request('state.read', {})).toMatchObject({ ok: true });
  });

  it('the desk’s own renewal keeps every channel and sends phones nothing', async () => {
    const { phone, deskKeys, carried, service, wires, desk, socket } = await joined();
    const sockets = service.sockets.length;
    const states: string[] = [];
    const stop = setInterval(() => states.push(desk.view().link.state), 1);
    // The sign-in has a minute and a little left: the desk renews its socket now.
    service.welcome(socket, Date.now() + 60_000 + 20);
    await until(() => service.sockets.length > sockets, 'the desk renews');
    const before = carried.length;
    wires.wire();
    await until(() => socket.closedWith !== null, 'the old socket is let go');
    clearInterval(stop);
    expect(new Set(states)).toEqual(new Set(['connected']));
    expect(toPhone(carried, before)).toEqual([]);
    // The phone, which may have been away all along, carries on with the channel it had, or a new one.
    expect(await phone.request('state.read', {})).toMatchObject({ ok: true });
    await phone.open(deskKeys);
    expect(await phone.request('state.read', {})).toMatchObject({ ok: true });
  });

  // The relay routes a frame to the old socket just before the new one replaces it, and it reaches the desk
  // after the desk switched: the desk reads the old socket until it has closed, so the frame is answered.
  it('a hello that reaches the old socket just after the renewal is still answered', async () => {
    const { phone, deskKeys, carried, service, wires, socket, tamperNext } = await joined();
    const sockets = service.sockets.length;
    service.welcome(socket, Date.now() + 60_000 + 20);
    await until(() => service.sockets.length > sockets, 'the desk renews');
    wires.wire();
    await until(() => socket.closedWith !== null, 'the desk switched to the new socket');
    // The relay routed the hello to the old socket before the new one replaced it; it lands now.
    let hello: Record<string, unknown> | null = null;
    tamperNext((frame) => ((hello = frame), { ...frame, to: 'nobody' }));
    const before = carried.length;
    void phone.open(deskKeys).catch(() => undefined);
    await until(() => hello !== null, 'the phone says hello');
    socket.events.message(JSON.stringify(hello));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(toPhone(carried, before).map((f) => f.kind)).toEqual(['hello']);
    // Once the old socket has closed, nothing more is read from it.
    socket.events.closed(1000, 'renewed');
    const after = carried.length;
    socket.events.message(JSON.stringify(hello));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(toPhone(carried, after)).toEqual([]);
  });
});

describe('removing a device', () => {
  it('ends its access at once: its channel closes and every later frame is refused', async () => {
    const { desk, phone, deskKeys } = await joined();
    const answer = await connectRoute(['api', 'connect', 'devices', PHONE], 'DELETE', async () => ({}), desk);
    expect(answer?.status).toBe(200);
    expect((answer!.body as { devices: { id: string }[] }).devices.map((d) => d.id)).not.toContain(PHONE);
    await until(() => phone.lastBye !== null, 'the phone hears');
    expect(phone.lastBye).toContain('removed');
    await expect(phone.request('state.read', {})).rejects.toThrow('Open the channel first.');
    await expect(phone.open(deskKeys)).rejects.toThrow('Your Mac does not know this device');
    expect(await connectRoute(['api', 'connect', 'devices', PHONE], 'DELETE', async () => ({}), desk)).toEqual({ status: 409, body: { error: 'That device is not on your account.' } });
    expect(await connectRoute(['api', 'connect', 'devices', desk.device()!.id], 'DELETE', async () => ({}), desk)).toMatchObject({ status: 409, body: { error: expect.stringContaining('cannot remove itself') } });
  });

  it('a removed phone’s old sealed frame is refused too', async () => {
    const { desk, phone, carried } = await joined();
    const frame = phone.sealedRequest('state.read', {});
    await desk.removeDevice(PHONE);
    const before = carried.length;
    phone.sendRaw(frame);
    await until(() => carried.length > before, 'an answer');
    expect(carried.at(-1)).toContain('Your Mac does not know this device');
  });
});

describe('the account data key and held conversations, through the module', () => {
  it('makes the key when connected, and gives it to the phone it lets in', async () => {
    const t = await joined();
    await until(() => t.service.held.copies.has(PHONE), 'the phone is given the key');
    expect(t.desk.view().keys).toMatchObject({ state: 'ready', generation: 1, wordsToShow: true });
    expect(t.service.held.keyring!.version).toBe(2);
  });

  it('removing the phone removes it from the account and rotates the key without it', async () => {
    const t = await joined();
    await until(() => t.service.held.copies.has(PHONE), 'the phone is given the key');
    await t.desk.recoveryPutAway();
    await t.desk.removeDevice(PHONE);
    expect(t.service.removed).toEqual([PHONE]);
    await until(() => t.service.held.generation === 2, 'the key is rotated');
    expect(t.service.held.copies.has(PHONE)).toBe(false);
    await until(() => t.desk.view().keys.state === 'ready' && (t.desk.view().keys as { generation: number }).generation === 2, 'the new key is open');
    expect(t.desk.view().keys).toMatchObject({ wordsToShow: true, changedBecause: ['Test phone'] });
  });

  it('takes a waiting message when the service says one arrived', async () => {
    const t = await alone();
    await until(() => t.desk.keys.ready() !== null, 'the key is open');
    const session = await t.runtime.start({ agent: 'claude', projectId: null, prompt: 'hello' });
    await until(() => t.fake.turns.length === 1, 'the first turn');
    const key = t.desk.keys.ready()!;
    const deskId = t.desk.device()!.id;
    t.service.held.post({ id: 'w1', from: PHONE, to: deskId, generation: key.generation, body: sealRecord(key.adk, 'message', 'w1', key.generation, { v: 1, sessionId: session.id, text: 'sent while away', sentAt: 1, from: { id: PHONE, name: 'Test phone' } }) });
    t.socket.events.message(JSON.stringify({ service: 'held-messages', count: 1 }));
    await until(() => t.fake.turns.some((turn) => turn.text.includes('sent while away')), 'the waiting message is sent into its session');
    expect(t.service.held.messages.size).toBe(0);
  });

  it('tells a phone that registered for notifications, read again when the service says one did', async () => {
    const t = await alone();
    await until(() => t.desk.keys.ready() !== null, 'the key is open');
    expect(t.desk.view().push.phones).toEqual([]);
    t.service.held.addDevice(PHONE, 'Test phone', 'phone');
    t.service.held.registerPhone(PHONE, 'token-1');
    t.socket.events.message(JSON.stringify({ service: 'push-devices' }));
    await until(() => t.desk.view().push.phones.length === 1, 'the phone is read');
    expect(t.desk.view().push.phones).toEqual(['Test phone']);
    const session = await t.runtime.start({ agent: 'claude', projectId: null, prompt: 'hello' });
    await until(() => t.fake.turns.length === 1, 'the first turn');
    await t.runtime.idle(session.id);
    await t.desk.push!.settle();
    // The sign-in expired between the key read and the push: the push is sent again with a renewed one, not lost.
    const stale = (await t.vault.read()).tokens!.accessToken;
    t.service.rejected.add(stale);
    t.fake.hold = true;
    t.fake.script = (turn) => turn.emit({ type: 'needs-input', request: { id: 'r1', kind: 'approval', title: 'Run', detail: 'ls', tool: 'Bash', options: [{ id: 'y', label: 'Allow', role: 'allow' }, { id: 'n', label: 'Deny', role: 'deny' }] } });
    await t.runtime.reply(session.id, 'go on', {});
    await until(async () => (await t.workspace.state()).sessions.some((s) => s.state === 'attention'), 'the session asks');
    await t.desk.push!.settle();
    expect(t.service.held.pushed.map((p) => p.deviceId)).toEqual([PHONE]);
    const posts = t.service.seen.filter((c) => c.startsWith('POST /push '));
    expect(posts).toHaveLength(2);
    expect(posts[0]).toBe(`POST /push ${stale}`);
    expect(posts[1]).not.toContain(stale);
  });

  it('removing a device is retried once with a renewed sign-in when the service refuses the old one', async () => {
    const t = await joined();
    await until(() => t.service.held.copies.has(PHONE), 'the phone is given the key');
    t.service.rejected.add((await t.vault.read()).tokens!.accessToken);
    await t.desk.removeDevice(PHONE);
    expect(t.service.removed).toEqual([PHONE]);
    expect(t.service.seen.filter((c) => c.startsWith(`DELETE /devices/${PHONE}`))).toHaveLength(2);
  });

  it('opens the key again when the service says its copy changed', async () => {
    const t = await alone();
    await until(() => t.desk.keys.ready() !== null, 'the key is open');
    const reads = () => t.service.held.calls.filter((c) => c === 'GET /keys').length;
    const before = reads();
    t.socket.events.message(JSON.stringify({ service: 'key-changed', generation: 1 }));
    await until(() => reads() > before, 'the key is read again');
  });

  it('keeps a project off from either place through one list, and deletes what was held of it', async () => {
    const t = await alone();
    await until(() => t.desk.keys.ready() !== null, 'the key is open');
    const project = await createProject(t.workspace, { name: 'Shop' });
    await t.runtime.start({ agent: 'claude', projectId: project.id, prompt: 'set it up' });
    // The index and the Code reviews and Tickets lists are always held: three records before any session.
    await until(() => t.service.held.records.size > 4, 'the session is held');
    const pushed: string[][] = [];
    t.desk.onChange((view) => pushed.push(view.held.keptOff));
    const route = (keptOff: string[]) => connectRoute(['api', 'connect', 'held'], 'PATCH', async () => ({ keptOff }), t.desk);
    // The project's Settings tab and Settings → Connections both send the list keptOffWith makes.
    await route(keptOffWith(t.desk.view().held.keptOff, project.id, true));
    expect(t.desk.view().held.keptOff).toEqual([project.id]);
    expect(pushed.at(-1)).toEqual([project.id]); // what every window's other place shows
    await until(() => t.service.held.records.size === 4, 'what was held of it is deleted, the index and the lists alone left');
    await route(keptOffWith(t.desk.view().held.keptOff, project.id, false));
    expect(t.desk.view().held.keptOff).toEqual([]);
    await until(() => t.service.held.records.size > 4, 'held again');
  });

  it('saves the held-conversation choices as changed, and shows and puts away the recovery words', async () => {
    const t = await alone();
    await until(() => t.desk.keys.ready() !== null, 'the key is open');
    const route = (parts: string[], method: string, body: Record<string, unknown> = {}) => connectRoute(['api', 'connect', ...parts], method, async () => body, t.desk);
    expect(await route(['held'], 'PATCH', { keptOff: 'p1' })).toMatchObject({ status: 400 });
    const changed = await route(['held'], 'PATCH', { keptOff: ['p1'], attachments: true });
    expect(changed).toMatchObject({ status: 200, body: { held: { keptOff: ['p1'], attachments: true } } });
    expect(JSON.parse((await t.settings.getSetting(CONNECT_PREFS_KEY))!)).toEqual({ enabled: true, keptOff: ['p1'], attachments: true });
    const words = await route(['recovery'], 'GET');
    expect((words!.body as { words: string[] }).words).toHaveLength(24);
    expect(await route(['recovery', 'put-away'], 'POST')).toMatchObject({ status: 200, body: { keys: { wordsToShow: false } } });
    expect(await route(['recovery'], 'POST', { words: 'not right' })).toMatchObject({ status: 409, body: { error: expect.stringMatching(/24 recovery words/) } });
  });
});
