// `kestrel-node join` end to end, with no network: a worker node (the real Connect module as kind `node`, its
// control socket, the join flow) and a desktop of the account (two-desks.ts), on the fake service, relay and
// identity provider. The node is driven through its socket as a terminal would drive it (join-client.ts).
import { gitStatusOf } from '../shared/node-git-status.ts';
import { EMPTY_GIT_SETTINGS } from '../shared/node-git.ts';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { AgentAdapter } from '../agents/types.ts';
import { ConnectDispatcher } from '../connect/dispatcher.ts';
import { FakeIdentity, FakeRelay, FakeService } from '../connect/link/connect-fakes.ts';
import { KestrelConnect } from '../connect/link/connect.ts';
import { DEVICE_CODE_EXPIRED, DEVICE_SIGN_IN_DENIED } from '../connect/link/identity.ts';
import { closeDesks, newDesk, type Desk } from '../connect/link/two-desks.ts';
import { memoryVault } from '../connect/link/vault.ts';
import { SELECTABLE_AGENTS, type Agent } from '../model.ts';
import { memoryPersistence } from '../persistence/memory.ts';
import { SessionRuntime } from '../runtime.ts';
import { JOIN_NEXT } from '../shared/node-commands.ts';
import { nodeStatusOf, REMOVED_NODE, statusLines } from '../shared/node-status.ts';
import { memorySettings } from '../suggestions/prefs.ts';
import { FakeAgents, until } from '../test-agent.ts';
import { Workspace } from '../workspace.ts';
import { listenControl, type ControlSocket } from './control-socket.ts';
import { applyNodeDefaults } from './defaults.ts';
import { runJoinClient, STOPPED_EXIT } from './join-client.ts';
import { joinFlow } from './join-flow.ts';
import { nodeSocketPath } from './socket-path.ts';
import { connectStatusOf } from './start-node.ts';

const NODE = 'Worker node 1';
let dir: string;
let control: ControlSocket | null = null;
let node: KestrelConnect | null = null;
let wiring: ReturnType<typeof setInterval> | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kn-'));
});
afterEach(async () => {
  if (wiring) clearInterval(wiring);
  await control?.close();
  await node?.close();
  await closeDesks();
  control = node = wiring = null;
  rmSync(dir, { recursive: true, force: true });
});

/** The laptop makes the account; the node starts signed out, with Connect on as a node starts, and its control socket. */
async function setup() {
  const service = new FakeService();
  const relay = new FakeRelay(service);
  const laptop = await newDesk(service, relay, 'MacBook Pro');
  await until(() => laptop.desk.keys.ready() !== null, 'the account key is made');
  // Every socket the node opens is wired to the relay as it opens.
  wiring = setInterval(() => relay.wire(), 5);
  const identity = new FakeIdentity();
  identity.deviceIntervalMs = 10;
  const workspace = new Workspace(memoryPersistence());
  const fake = new FakeAgents();
  const adapters = Object.fromEntries(SELECTABLE_AGENTS.map((a): [Agent, AgentAdapter] => [a, { ...fake.adapter(), agent: a }])) as Record<Agent, AgentAdapter>;
  const runtime = new SessionRuntime(workspace, adapters, realpathSync(mkdtempSync(join(tmpdir(), 'kn-run-'))));
  const settings = memorySettings();
  await applyNodeDefaults(settings);
  const connect = new KestrelConnect({ kind: 'node', vault: memoryVault(undefined, 'file'), identity, service, settings, computerName: NODE, here: NODE, callTimeoutMs: 400, dispatch: (deviceId, send, desk) => new ConnectDispatcher({ workspace, runtime, deviceId, here: NODE, send, desk, keptOff: () => [] }) });
  node = connect;
  await connect.start();
  control = await listenControl(nodeSocketPath(dir), { status: async () => Promise.reject(new Error('not in this test')), stop: () => undefined, join: (io, signal) => joinFlow(connect, io, signal), uninstall: async () => ({ ok: false, reason: 'not in this test' }), agents: async () => [], git: async () => ({ name: 'n', repositories: [], others: [], accountUnknown: null, othersUnknown: null }) });
  return { service, relay, laptop, identity, node: connect, path: control.path };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** `kestrel-node join` in a terminal: every line printed, and each question answered by `answer`. */
function terminal(path: string, answer: (prompt: string) => Promise<string> = () => new Promise(() => undefined)) {
  const lines: string[] = [];
  const asked: string[] = [];
  const client = runJoinClient(path, { out: (l) => lines.push(l), err: (l) => lines.push(l), ask: (prompt) => (asked.push(prompt), answer(prompt)) });
  const said = (pattern: RegExp) => lines.find((l) => pattern.test(l));
  /** Everything printed as one text: wrapped lines joined again. */
  const text = () => lines.filter(Boolean).join(' ');
  return { ...client, lines, asked, said, text };
}

/** The person signs in on another device, and the laptop hears the node ask. */
async function signInAndAsk(s: Setup, t: ReturnType<typeof terminal>) {
  await until(() => t.said(/WDJB-MJHT/) !== undefined, 'the sign-in code is shown');
  s.identity.device = 'signed-in';
  await until(() => s.laptop.desk.view().requests.length === 1, 'the laptop hears the node ask to join');
  return s.laptop.desk.view().requests[0]!;
}

/** The laptop opens the request and reads the code the node shows in the terminal. */
async function openAndReadCode(laptop: Desk, id: string, t: ReturnType<typeof terminal>): Promise<string> {
  laptop.desk.openRequest(id);
  await until(() => t.said(/^ {7}\d{3} \d{3}$/) !== undefined, 'the node shows the first code');
  return t.said(/^ {7}\d{3} \d{3}$/)!.trim();
}

describe('kestrel-node join', () => {
  test('signs in by a code typed on another device, asks to join as a node, and is let in by the two codes', async () => {
    // Arrange
    const s = await setup();
    let second: string | null = null;
    const t = terminal(s.path, async () => {
      await until(() => second !== null, 'the laptop shows the second code');
      return second!;
    });
    // Act: sign in, then the person types the node's code on the laptop and the laptop's code on the node.
    const request = await signInAndAsk(s, t);
    const first = await openAndReadCode(s.laptop, request.id, t);
    await s.laptop.desk.typeCode(request.id, first);
    await until(() => s.laptop.desk.view().requests.find((r) => r.id === request.id)?.code != null, 'the laptop shows the second code');
    second = s.laptop.desk.view().requests.find((r) => r.id === request.id)!.code;
    const code = await t.done;
    // Assert
    expect(code).toBe(0);
    expect(t.lines.slice(0, 5)).toEqual([`Kestrel worker node: join ${NODE} to your account`, '', '1  Sign in', '   Open   https://id.example.test/device', expect.stringMatching(/^ {3}Code {3}WDJB-MJHT {3}\(works for \d+ minutes?\)$/)]);
    expect(t.lines.filter((l) => /^\d {2}/.test(l))).toEqual(['1  Sign in', '2  Let this node in', '3  Confirm']);
    expect(t.said(/^ {3}ok: Signed in as person@example\.com$/)).toBeDefined();
    expect(t.said(/^ {3}MacBook Pro opened it\. Type this code there:$/)).toBeDefined();
    expect(t.said(/^ {3}ok: MacBook Pro let it in$/)).toBeDefined();
    expect(t.asked).toEqual(['   Type the code MacBook Pro shows now: ']);
    expect(t.lines.slice(-3)).toEqual([`ok: ${NODE} is in your account and connected to Kestrel Connect.`, '', `Next: ${JOIN_NEXT}`]);
    // One sign-in address, and the node's name said in the title and the last line only.
    expect(t.lines.filter((l) => l.includes('https://'))).toHaveLength(1);
    expect(t.text().split(NODE).length - 1).toBeLessThanOrEqual(3);
    // Plain ASCII where the output is not a terminal.
    expect(t.lines.join('\n')).toMatch(/^[\x20-\x7e\n]*$/);
    const nodeId = s.node.device()!.id;
    expect(request).toMatchObject({ name: NODE, kind: 'node' });
    expect(s.service.held.devices.get(nodeId)?.kind).toBe('node');
    expect(s.node.inAccount()).toBe(true);
    await until(() => s.laptop.desk.keys.device(nodeId)?.kind === 'node', 'the laptop’s keyring lists the node as a node');
    await until(() => s.laptop.desk.view().devices.some((d) => d.id === nodeId && d.kind === 'node' && d.inAccount), 'the laptop’s device list shows the node');
    expect(s.laptop.desk.otherComputers()).toEqual([{ id: nodeId, name: NODE }]);
    // Nothing secret was printed: only the sign-in code and the two six-digit codes.
    expect(t.lines.join('\n')).not.toMatch(/access-|refresh-|device-code|verifier|PRIVATE KEY/);
  });

  test('a desktop may ask the node what it asks any computer, and the node may ask the desktop', async () => {
    const s = await setup();
    let second: string | null = null;
    const t = terminal(s.path, async () => {
      await until(() => second !== null, 'second code');
      return second!;
    });
    const request = await signInAndAsk(s, t);
    await s.laptop.desk.typeCode(request.id, await openAndReadCode(s.laptop, request.id, t));
    await until(() => s.laptop.desk.view().requests[0]?.code != null, 'second code');
    second = s.laptop.desk.view().requests[0]!.code;
    expect(await t.done).toBe(0);
    await until(() => s.laptop.desk.keys.member(s.node.device()!.id) !== null && s.node.keys.member(s.laptop.id()) !== null, 'each is in the other’s keyring');
    expect(await s.laptop.desk.remote.ask(s.node.device()!.id, 'state.read', {})).toMatchObject({ ok: true });
    expect(await s.node.remote.ask(s.laptop.id(), 'state.read', {})).toMatchObject({ ok: true });
  });

  test('refuses plainly when the node is in the account already', async () => {
    const s = await setup();
    let second: string | null = null;
    const t = terminal(s.path, async () => {
      await until(() => second !== null, 'second code');
      return second!;
    });
    const request = await signInAndAsk(s, t);
    await s.laptop.desk.typeCode(request.id, await openAndReadCode(s.laptop, request.id, t));
    await until(() => s.laptop.desk.view().requests[0]?.code != null, 'second code');
    second = s.laptop.desk.view().requests[0]!.code;
    expect(await t.done).toBe(0);
    const again = terminal(s.path);
    expect(await again.done).toBe(1);
    expect(again.text()).toBe(`${NODE} is in your account already. To join it again, remove it from another of your devices first.`);
  });

  test('three wrong first codes typed on the desktop end the request, and the node says why', async () => {
    const s = await setup();
    const t = terminal(s.path);
    const request = await signInAndAsk(s, t);
    await openAndReadCode(s.laptop, request.id, t);
    for (let i = 0; i < 3; i++) await s.laptop.desk.typeCode(request.id, '000 000').catch(() => undefined);
    expect(await t.done).toBe(1);
    expect(t.text()).toMatch(/Three wrong codes were typed on MacBook Pro\. Ask again if this was you\. Next: kestrel-node join$/);
    expect(s.node.inAccount()).toBe(false);
  });

  test('three wrong second codes typed on the node discard the key it was offered', async () => {
    const s = await setup();
    const t = terminal(s.path, async () => '000 000');
    const request = await signInAndAsk(s, t);
    await s.laptop.desk.typeCode(request.id, await openAndReadCode(s.laptop, request.id, t));
    expect(await t.done).toBe(1);
    expect(t.asked).toHaveLength(3);
    expect(t.said(/That is not the code MacBook Pro shows\. 2 tries left\./)).toBeDefined();
    expect(t.text()).toMatch(/Three wrong codes were typed, so Worker node 1 did not keep the key it was offered\..* Next: kestrel-node join$/);
    expect(s.node.keys.ready()).toBeNull();
    expect(s.service.held.copies.has(s.node.device()!.id)).toBe(false);
  });

  test('an expired sign-in code says so plainly', async () => {
    const s = await setup();
    const t = terminal(s.path);
    await until(() => t.said(/WDJB-MJHT/) !== undefined, 'the sign-in code is shown');
    s.identity.device = 'expired';
    expect(await t.done).toBe(1);
    expect(t.text().endsWith(DEVICE_CODE_EXPIRED)).toBe(true);
    expect(s.node.view().account).toEqual({ state: 'signed-out', reason: DEVICE_CODE_EXPIRED });
  });

  test('a sign-in refused on the other device says so plainly', async () => {
    const s = await setup();
    const t = terminal(s.path);
    await until(() => t.said(/WDJB-MJHT/) !== undefined, 'the sign-in code is shown');
    s.identity.device = 'denied';
    expect(await t.done).toBe(1);
    expect(t.text().endsWith(DEVICE_SIGN_IN_DENIED)).toBe(true);
  });

  test('Ctrl-C while signing in cancels the sign-in; while asking, ends the request', async () => {
    const s = await setup();
    const signingIn = terminal(s.path);
    await until(() => signingIn.said(/WDJB-MJHT/) !== undefined, 'the sign-in code is shown');
    signingIn.stop();
    expect(await signingIn.done).toBe(STOPPED_EXIT);
    await until(() => s.node.view().account.state === 'signed-out', 'the sign-in is cancelled');
    const polls = s.identity.polls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(s.identity.polls.length).toBe(polls);
    // Again, this time stopped while the request waits for a device to open it.
    const asking = terminal(s.path);
    await signInAndAsk(s, asking);
    asking.stop();
    expect(await asking.done).toBe(STOPPED_EXIT);
    await until(() => s.service.held.joins.size === 0, 'the request is withdrawn at the service');
  });
});

describe('a node in the account', () => {
  test('leaves a rotation, and the new recovery words it makes, to a computer with a screen', async () => {
    // Arrange: a node let in; then the service says a removed device's key is due to be rotated.
    const s = await setup();
    let second: string | null = null;
    const t = terminal(s.path, async () => {
      await until(() => second !== null, 'second code');
      return second!;
    });
    const request = await signInAndAsk(s, t);
    await s.laptop.desk.typeCode(request.id, await openAndReadCode(s.laptop, request.id, t));
    await until(() => s.laptop.desk.view().requests[0]?.code != null, 'second code');
    second = s.laptop.desk.view().requests[0]!.code;
    expect(await t.done).toBe(0);
    const generation = s.service.held.generation;
    s.service.held.rotationDue = [{ name: 'Old phone', removedAt: new Date(0).toISOString() }];
    // Act
    await s.node.keys.sync();
    // Assert: the node did not rotate; the laptop does, and shows the new words there.
    expect(s.service.held.generation).toBe(generation);
    await s.laptop.desk.keys.sync();
    expect(s.service.held.generation).toBe(generation! + 1);
    expect(s.laptop.desk.view().keys).toMatchObject({ state: 'ready', wordsToShow: true });
  });
});

describe('a node removed from the account', () => {
  test('is refused by the desktop, stops dialling, and its status says it is no longer in and how to join again', async () => {
    // Arrange: a node let in.
    const s = await setup();
    let second: string | null = null;
    const t = terminal(s.path, async () => {
      await until(() => second !== null, 'second code');
      return second!;
    });
    const request = await signInAndAsk(s, t);
    await s.laptop.desk.typeCode(request.id, await openAndReadCode(s.laptop, request.id, t));
    await until(() => s.laptop.desk.view().requests[0]?.code != null, 'second code');
    second = s.laptop.desk.view().requests[0]!.code;
    expect(await t.done).toBe(0);
    const nodeId = s.node.device()!.id;
    await until(() => s.laptop.desk.keys.member(nodeId) !== null, 'the laptop trusts the node');
    // Act: the laptop removes it; the relay closes the node's socket as removed.
    await s.laptop.desk.removeDevice(nodeId);
    const asked = await s.node.remote.ask(s.laptop.id(), 'state.read', {});
    const sockets = s.service.sockets.length;
    s.service.sockets.filter((socket) => socket.deviceId === nodeId).at(-1)!.events.closed(4001, 'removed');
    await until(() => s.node.wasRemoved(), 'the node hears it was removed');
    // Assert
    expect(asked.ok).toBe(false);
    expect(s.node.inAccount()).toBe(false);
    expect(s.node.device()).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(s.service.sockets.length).toBe(sockets);
    const status = nodeStatusOf({ version: '0.0.34', kind: 'node', platform: 'linux', name: NODE, connect: connectStatusOf(s.node), agents: [], availability: { available: [], notes: {} }, sandbox: { available: true }, git: gitStatusOf(EMPTY_GIT_SETTINGS, false), host: { user: 'kestrel', lingering: 'on', service: { manager: 'systemd', installed: true, active: true, mainPid: 4242 }, disk: { path: '/home/user/.kestrel', freeBytes: 50 * 1024 ** 3 }, bundle: { version: '0.0.34', path: '/home/user/.kestrel/node/0.0.34' } }, pid: 4242 });
    expect(status.connect).toMatchObject({ inAccount: false, removed: true, connected: false });
    expect(statusLines(status).join('\n')).toContain(REMOVED_NODE);
  });

  test('a node that leaves (uninstall) is removed from the account at the service, signed out, and forgets its device', async () => {
    // Arrange: the node joins.
    const s = await setup();
    let second: string | null = null;
    const t = terminal(s.path, async () => {
      await until(() => second !== null, 'second code');
      return second!;
    });
    const request = await signInAndAsk(s, t);
    await s.laptop.desk.typeCode(request.id, await openAndReadCode(s.laptop, request.id, t));
    await until(() => s.laptop.desk.view().requests[0]?.code != null, 'second code');
    second = s.laptop.desk.view().requests[0]!.code;
    expect(await t.done).toBe(0);
    const nodeId = s.node.device()!.id;
    expect(s.service.held.devices.has(nodeId)).toBe(true);
    // Act
    const outcome = await s.node.leaveAccount();
    // Assert
    expect(outcome).toBe('left');
    expect(s.service.held.devices.has(nodeId)).toBe(false);
    expect(s.node.device()).toBeNull();
    expect(s.node.view().account.state).toBe('signed-out');
    expect(s.node.inAccount()).toBe(false);
  });

  test('a node never signed in has no account to leave', async () => {
    const s = await setup();
    expect(await s.node.leaveAccount()).toBe('not-signed-in');
  });
});
