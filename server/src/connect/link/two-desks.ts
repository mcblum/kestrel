// Two desks of one account on the fake service and its relay, each with the real Connect module and a real runtime
// whose agents are fakes, the laptop serving its window over HTTP and WebSocket: what the tests of a session that
// runs on another computer share (remote-sessions.test.ts, remote-actions.test.ts). Not imported by the app.
import { mkdtempSync, realpathSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { AgentAdapter } from '../../agents/types.ts';
import { createKestrelServer, type KestrelServerOptions } from '../../http.ts';
import { SELECTABLE_AGENTS, type Agent, type ChatMessage } from '../../model.ts';
import { memoryPersistence } from '../../persistence/memory.ts';
import { createProject } from '../../project-store.ts';
import { SessionRuntime } from '../../runtime.ts';
import { memorySettings } from '../../suggestions/prefs.ts';
import { FakeAgents, until } from '../../test-agent.ts';
import { Workspace } from '../../workspace.ts';
import { ConnectDispatcher } from '../dispatcher.ts';
import { connectLists } from '../lists.ts';
import { FakeIdentity, FakeRelay, FakeService, fakeListener, tokensFor } from './connect-fakes.ts';
import { CONNECT_PREFS_KEY, KestrelConnect, type ConnectDeps } from './connect.ts';
import { heldSource } from './held.ts';
import { seenSource } from './seen-sync.ts';
import { memoryQueueStore } from './held-queue.ts';
import { pushSource } from './push.ts';
import { memoryVault } from './vault.ts';

const TOKEN = 'test-token';
let cleanup: Array<() => Promise<void> | void> = [];

/** Closes what the last test opened; a test file calls it after each test. */
export async function closeDesks(): Promise<void> {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
}

/** A desk of the account: the real Connect module with a dispatcher over a real runtime, every agent a fake. */
export async function newDesk(service: FakeService, relay: FakeRelay, name: string, setup?: ConnectDeps['setup']) {
  const workspace = new Workspace(memoryPersistence());
  const fake = new FakeAgents();
  const adapters = Object.fromEntries(SELECTABLE_AGENTS.map((a): [Agent, AgentAdapter] => [a, { ...fake.adapter(), agent: a }])) as Record<Agent, AgentAdapter>;
  const runtime = new SessionRuntime(workspace, adapters, realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-remote-'))));
  const settings = memorySettings();
  await settings.putSetting(CONNECT_PREFS_KEY, JSON.stringify({ enabled: true }));
  const desk = new KestrelConnect({
    vault: memoryVault({ tokens: tokensFor(0, Date.now()), device: null }),
    identity: new FakeIdentity(),
    service,
    settings,
    computerName: name,
    listen: fakeListener().listen,
    here: name,
    dispatch: (deviceId, send, desk) => new ConnectDispatcher({ workspace, runtime, deviceId, here: name, send, desk, keptOff: () => [] }),
    held: { source: heldSource(workspace, runtime, connectLists(runtime.reviewPrefs, null, null)), queue: memoryQueueStore() },
    push: { source: pushSource(workspace, runtime, null, null) },
    replica: workspace.account,
    seen: seenSource(workspace),
    callTimeoutMs: 400,
    ...(setup ? { setup } : {}),
  });
  cleanup.push(() => desk.close());
  const count = service.sockets.length;
  await desk.start();
  await until(() => service.sockets.length > count, `${name} dials`);
  relay.wire();
  await until(() => desk.view().link.state === 'connected', `${name} connects`);
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await fake.settled();
      for (const s of (await workspace.state()).sessions) await runtime.idle(s.id);
    }
  };
  return { workspace, runtime, fake, desk, settings, settle, id: () => desk.device()!.id };
}

/** A window's POST as it came back: the status, and the body's error or answer (null for 204). */
export interface Posted {
  status: number;
  body: ({ error?: string } & Record<string, unknown>) | null;
}

/** The laptop makes the account; the Mac mini asks to join and the laptop lets it in with both codes. */
export async function account(setup: { laptop?: ConnectDeps['setup']; mini?: ConnectDeps['setup'] } = {}) {
  const service = new FakeService();
  const relay = new FakeRelay(service);
  const laptop = await newDesk(service, relay, 'MacBook Pro', setup.laptop);
  await until(() => laptop.desk.keys.ready() !== null, 'the account key is made');
  const mini = await newDesk(service, relay, 'Mac mini', setup.mini);
  await until(() => laptop.desk.view().requests.length === 1, 'the laptop hears the Mac mini ask');
  const request = laptop.desk.view().requests[0]!;
  laptop.desk.openRequest(request.id);
  await until(() => mini.desk.view().joining?.state === 'code', 'the Mac mini shows a code');
  await laptop.desk.typeCode(request.id, (mini.desk.view().joining as { code: string }).code);
  await until(() => mini.desk.view().joining?.state === 'confirm', 'the Mac mini asks for the second code');
  const second = laptop.desk.view().requests.find((r) => r.id === request.id)!.code!;
  await mini.desk.confirmJoin(second);
  await until(() => mini.desk.keys.ready() !== null && laptop.desk.keys.member(mini.id()) !== null && mini.desk.keys.member(laptop.id()) !== null, 'each is in the other’s keyring');
  return { service, relay, laptop, mini };
}

export type Desk = Awaited<ReturnType<typeof newDesk>>;

/**
 * The laptop's window: its HTTP routes and one WebSocket, recording the live patches it is sent. `withRuntime`
 * serves it with the laptop's own runtime too, as the app does (its drafts are where a reply's files are).
 */
export async function laptopWindow(laptop: Desk, withRuntime = false, options: KestrelServerOptions = {}) {
  const policy = { token: TOKEN, allowedOrigins: ['http://localhost:5173'], port: 0 };
  const app = createKestrelServer(laptop.workspace, policy, withRuntime ? laptop.runtime : undefined, { connect: laptop.desk, ...options });
  await app.listen();
  cleanup.push(() => app.close());
  policy.port = (app.server.address() as AddressInfo).port;
  const get = async (path: string) => (await fetch(`http://127.0.0.1:${policy.port}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  /** A POST as the window makes it: the status and the answer's body (null when there is none). */
  const post = async (path: string, body: unknown = {}): Promise<Posted> => {
    const res = await fetch(`http://127.0.0.1:${policy.port}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };
  /** A file uploaded to a draft, as the message box does it. */
  const upload = async (draftId: string, name: string, type: string, bytes: Buffer): Promise<{ id: string }> => {
    const res = await fetch(`http://127.0.0.1:${policy.port}/api/attachments/drafts/${draftId}?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': type }, body: new Uint8Array(bytes) });
    return (await res.json()) as { id: string };
  };
  const socket = new WebSocket(`ws://127.0.0.1:${policy.port}/ws?token=${TOKEN}`, { origin: 'http://localhost:5173' });
  const live: { sessionId: string; patch: { messages?: ChatMessage[]; status?: string } }[] = [];
  socket.on('message', (raw) => {
    const m = JSON.parse(String(raw)) as { type?: string; sessionId: string; patch: never };
    if (m.type === 'live') live.push(m);
  });
  await new Promise((resolve) => socket.once('open', resolve));
  cleanup.push(() => socket.close());
  return { get, post, upload, live, send: (m: object) => socket.send(JSON.stringify(m)) };
}

/** The Mac mini runs a session of `agent` with `turns` turns, held whole on the account; the laptop reads the feed. */
export async function remoteSession(a: Awaited<ReturnType<typeof account>>, agent: Agent, turns: number) {
  const { laptop, mini } = a;
  mini.fake.script = (turn) => turn.emit({ type: 'message', id: `a${turn.n}`, text: `answer ${turn.n}`, delta: `answer ${turn.n}`, done: true });
  const project = await createProject(mini.workspace, { name: 'Shop' });
  const session = await mini.runtime.start({ agent, projectId: project.id, prompt: 'question 1' });
  await mini.settle();
  for (let n = 2; n <= turns; n++) {
    await mini.runtime.reply(session.id, `question ${n}`);
    await mini.settle();
  }
  await mini.desk.held!.run();
  await laptop.desk.replica!.run();
  await until(async () => (await laptop.workspace.view()).sessions.some((s) => s.id === session.id), 'the laptop lists the session');
  return session;
}

