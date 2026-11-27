import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONNECT_PREFS_KEY, connectPrefsJson } from '../connect/link/connect.ts';
import { memoryPersistence } from '../persistence/memory.ts';
import type { Persistence } from '../persistence/types.ts';
import { REMOTE_STARTS_KEY } from '../remote-starts/prefs.ts';
import { FakeAgents } from '../test-agent.ts';
import { startKestrel, type KestrelHandle } from '../start-server.ts';
import { needsWindow, WINDOW_THINGS, type WindowThing } from '../shared/no-window.ts';
import { NO_KEYSTORE_NOTE } from '../shared/protected-files.ts';
import { askNode } from './client.ts';
import { startNode, type NodeHandle } from './start-node.ts';
import { nodeSocketPath } from './socket-path.ts';

// Sample data, the stand-in agent and a store in memory: no model is called and nothing reaches the network.
const ENV = { KESTREL_FAKE: '1', KESTREL_PERSISTENCE: 'memory' };

let dir: string;
let agents: FakeAgents;
let db: Persistence;
let nodes: NodeHandle[];
let apps: KestrelHandle[];
let fetched: MockInstance<typeof fetch>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kn-'));
  agents = new FakeAgents();
  db = memoryPersistence();
  nodes = [];
  apps = [];
  fetched = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('This test reaches no network.'));
});
afterEach(async () => {
  for (const node of nodes) await node.close();
  for (const app of apps) await app.close();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const node = async (persistence: Persistence = db): Promise<NodeHandle> => {
  const started = await startNode({ dataDir: dir, port: 0, env: ENV, persistence, adapters: { claude: agents.adapter() } });
  nodes.push(started);
  return started;
};

interface Answer {
  status: number;
  body: { error?: string; [key: string]: unknown };
}

/** One loopback request, over node:http so the fetch guard stays untouched. */
function call(handle: KestrelHandle, method: string, path: string, options: { token?: boolean; origin?: string; host?: string; body?: unknown } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.token !== false) headers.Authorization = `Bearer ${handle.token}`;
    if (options.origin) headers.Origin = options.origin;
    if (options.host) headers.Host = options.host;
    const req = request({ host: '127.0.0.1', port: handle.port, method, path, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} }));
    });
    req.on('error', reject);
    req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });
}

describe('a worker node, started through the same function as the app', () => {
  test('runs a session to the end of a turn, then refuses everything that needs a window, naming the computer', async () => {
    // Arrange
    const { server } = await node();
    const name = server.connect.view().computerName;
    const refusals = needsWindow('node', name);
    const session = await server.runtime.start({ agent: 'claude', projectId: null, prompt: 'hello', title: 'Node check' });

    // Act: the turn runs to its end
    await vi.waitFor(async () => expect((await server.workspace.state()).sessions.find((s) => s.id === session.id)?.state).toBe('done'));

    // Assert: each thing that needs a window is refused with its sentence, which names the computer and what was asked
    const said: Partial<Record<WindowThing, string[]>> = {};
    const browser = server.runtime.browser.hostFor(session.id);
    const browserResults = await Promise.all([browser.browserNavigate({ url: 'https://example.com' }), browser.browserRead({}), browser.browserClick({ ref: 1 }), browser.browserType({ ref: 1, text: 'x' }), browser.browserScreenshot(), browser.browserConsole()]);
    said.browser = browserResults.map((r) => (r.isError ? r.text : 'NOT REFUSED'));
    const sim = server.runtime.sim.hostFor(session.id);
    const simResults = await Promise.all([sim.simList(), sim.simBoot({ device: 'iPhone' }), sim.simLaunch({ bundle_id: 'com.example.app' }), sim.simScreenshot(), sim.simTap({ x: 1, y: 1 }), sim.simSwipe({ x1: 1, y1: 1, x2: 2, y2: 2 }), sim.simPinch({ x: 1, y: 1, scale: 2 }), sim.simType({ text: 'x' }), sim.simKey({ key: 'return' }), sim.simButton({ button: 'home' }), sim.simOpenUrl({ url: 'https://example.com' }), sim.simAppearance({ mode: 'dark' })]);
    said.simulator = simResults.map((r) => (r.isError ? r.text : 'NOT REFUSED'));
    const routes: Record<'open-in' | 'folder-chooser' | 'whats-new' | 'simulator', Answer[]> = {
      'open-in': [await call(server, 'POST', `/api/sessions/${session.id}/open-file`, { body: { path: 'a.txt', editor: 'code' } }), await call(server, 'POST', `/api/sessions/${session.id}/reveal-file`, { body: { path: 'a.txt' } }), await call(server, 'POST', '/api/open-folder', { body: { scope: session.id, app: 'finder' } })],
      'folder-chooser': [await call(server, 'POST', '/api/projects/list-folder', { body: { path: dir } })],
      'whats-new': [await call(server, 'GET', '/api/whats-new'), await call(server, 'POST', '/api/whats-new/shown', { body: { release: '0.0.34', hash: 'x' } })],
      simulator: [await call(server, 'GET', '/api/simulator')],
    };
    for (const thing of ['open-in', 'folder-chooser', 'whats-new', 'simulator'] as const) {
      expect(routes[thing].map((a) => a.status)).toEqual(routes[thing].map(() => 409));
      said[thing] = [...(said[thing] ?? []), ...routes[thing].map((a) => a.body.error ?? 'NOT REFUSED')];
    }
    said.notification = [server.runtime.noWindow.notification ?? 'NOT REFUSED'];

    for (const thing of WINDOW_THINGS) {
      expect(said[thing]?.length, thing).toBeGreaterThan(0);
      for (const sentence of said[thing] ?? []) {
        expect(sentence, thing).toBe(refusals[thing]);
        expect(sentence, thing).toContain(`${name} has no screen.`);
      }
    }
    expect(said.browser![0]).toContain('browser');
    expect(said.simulator![0]).toContain('simulator');
    expect(said['open-in']![0]).toContain('Open in');
    expect(said['folder-chooser']![0]).toContain('folder');
    expect(said['whats-new']![0]).toContain("What's new");
    expect(said.notification![0]).toContain('notification');
    expect(fetched).not.toHaveBeenCalled();
  });

  test('keeps the loopback listener, the token, and refuses every browser origin', async () => {
    const { server } = await node();
    expect(server.port).toBeGreaterThan(0);
    // With the token and no Origin (an agent out of process) a request works
    expect((await call(server, 'GET', '/api/state')).status).toBe(200);
    // Any Origin at all is refused, even the dev UI's
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173', 'https://example.com', 'null']) expect(await call(server, 'GET', '/api/state', { origin })).toMatchObject({ status: 403, body: { error: 'Origin not allowed' } });
    // The token and the Host check stay
    expect((await call(server, 'GET', '/api/state', { token: false })).status).toBe(401);
    expect((await call(server, 'GET', '/api/state', { host: 'evil.example' })).status).toBe(403);
  });

  test('a session’s Kestrel tools stay reachable over loopback with its own token', async () => {
    const { server } = await node();
    const session = await server.runtime.start({ agent: 'claude', projectId: null, prompt: 'hello', title: 'Node check' });
    const options = agents.starts[0]?.options;
    expect(options?.kestrelMcp?.url).toBe(`http://127.0.0.1:${server.port}/api/sessions/${session.id}/mcp`);
  });

  test('writes no launch file and keeps its protected store in a file only the user can read', async () => {
    const started = await node();
    expect(existsSync(join(dir, 'launch.json'))).toBe(false);
    expect(started.server.connect.view().storage).toBe('file');
    expect((await started.status()).secrets).toEqual({ storage: 'file', where: NO_KEYSTORE_NOTE });
    expect(statSync(nodeSocketPath(dir)).mode & 0o777).toBe(0o600);
  });

  test('starts with Kestrel Connect on and other devices allowed to start sessions, where nobody has said otherwise', async () => {
    const { server } = await node();
    expect(server.connect.view().enabled).toBe(true);
    expect(await server.runtime.remoteStarts.prefs()).toEqual({ allowed: true });
    expect(await db.getSetting(CONNECT_PREFS_KEY)).toBe(connectPrefsJson(true));
    expect(await db.getSetting(REMOTE_STARTS_KEY)).toBe('{"allowed":true}');
    // Crash reports are as the installed app has them: on, nothing written
    expect((await server.runtime.crashReports.prefs()).enabled).toBe(true);
  });

  test('keeps what the user already chose', async () => {
    await db.putSetting(CONNECT_PREFS_KEY, connectPrefsJson(false));
    await db.putSetting(REMOTE_STARTS_KEY, '{"allowed":false}');
    const { server } = await node();
    expect(server.connect.view().enabled).toBe(false);
    expect(await server.runtime.remoteStarts.prefs()).toEqual({ allowed: false });
  });

  test('answers status over the socket, and stop ends the server', async () => {
    const started = await node();
    const path = nodeSocketPath(dir);
    const said = await askNode(path, 'status');
    expect(said).toMatchObject({ ok: true, command: 'status', status: { kind: 'node', name: started.server.connect.view().computerName, agents: [{ agent: 'claude', canRun: true, why: null }] } });
    expect(await askNode(path, 'stop')).toMatchObject({ ok: true, command: 'stop' });
    await vi.waitFor(() => expect(existsSync(path)).toBe(false));
    await expect(call(started.server, 'GET', '/api/state')).rejects.toThrow();
  });

  test('stopping ends a running turn cleanly, the way quitting the app does', async () => {
    agents.hold = true;
    const started = await node();
    const session = await started.server.runtime.start({ agent: 'claude', projectId: null, prompt: 'hello', title: 'Node check' });
    await vi.waitFor(() => expect(agents.starts).toHaveLength(1));
    const stateOf = async () => (await started.server.workspace.state()).sessions.find((s) => s.id === session.id)?.state;
    expect(await stateOf()).toBe('running');
    await started.close();
    nodes.length = 0;
    expect(await stateOf()).not.toBe('running');
    expect(fetched).not.toHaveBeenCalled();
  });

  test('refuses to start a second node on the same folder', async () => {
    await node();
    await expect(startNode({ dataDir: dir, port: 0, env: ENV, persistence: memoryPersistence() })).rejects.toThrow(/already running/);
  });
});

describe('the app kind of the same start function', () => {
  const app = async (): Promise<KestrelHandle> => {
    const started = await startKestrel({ kind: 'app', dataDir: dir, port: 0, uiOrigins: ['http://localhost:5173'], env: { ...ENV, KESTREL_WHATS_NEW_DIR: dir }, persistence: memoryPersistence(), adapters: { claude: agents.adapter() } });
    apps.push(started);
    return started;
  };

  test('refuses nothing, writes the launch file for the page, and allows the UI’s origin', async () => {
    const started = await app();
    expect(Object.values(started.runtime.noWindow)).toEqual(WINDOW_THINGS.map(() => null));
    expect(statSync(join(dir, 'launch.json')).mode & 0o777).toBe(0o600);
    expect((await call(started, 'GET', '/api/state', { origin: 'http://localhost:5173' })).status).toBe(200);
    expect((await call(started, 'GET', '/api/whats-new')).status).toBe(200);
    expect((await call(started, 'POST', '/api/projects/list-folder', { body: { path: dir } })).status).toBe(200);
    expect(started.kind).toBe('app');
  });

  test('does not apply the node’s defaults: Connect stays off until the user turns it on', async () => {
    const started = await app();
    expect(started.connect.view().enabled).toBe(false);
  });
});
