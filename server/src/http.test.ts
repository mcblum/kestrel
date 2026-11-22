import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionRuntime } from './runtime.ts';
import { createKestrelServer, type KestrelServer } from './http.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { Workspace } from './workspace.ts';
import { Terminals } from './terminals.ts';
import { sessionToken } from './security.ts';
import { fakePty } from './terminal-test-support.ts';
import { makeRepo } from './test-repo.ts';

// Builds real git repositories: room under a loaded machine (test-timeouts.ts).
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

const TOKEN = 'test-token';
const ORIGIN = 'http://localhost:5173';
let app: KestrelServer;
let ws: Workspace;
let base: string;
let port: number;

beforeEach(async () => {
  ws = new Workspace(memoryPersistence());
  await ws.addProject({ id: 'bellbird', name: 'Bellbird', path: '/b', isGit: true });
  await ws.addSession({ id: 's1', title: 'One', agent: 'claude', startedIn: 'bellbird' });
  // Port 0 picks a free port; the policy needs the real one for the Host check.
  const policy = { token: TOKEN, allowedOrigins: [ORIGIN], port: 0 };
  app = createKestrelServer(ws, policy);
  await app.listen();
  port = (app.server.address() as AddressInfo).port;
  policy.port = port;
  base = `http://127.0.0.1:${port}`;
});
afterEach(() => app.close());

const auth = { Authorization: `Bearer ${TOKEN}` };

describe('a page of a conversation', () => {
  const get = (path: string) => fetch(`${base}${path}`, { headers: auth });
  beforeEach(() => ws.setDetail('s1', { messages: Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, author: 'agent' as const, time: '', text: `${i}` })) }));

  test('without asking for one, the whole conversation as before', async () => {
    const body = await (await get('/api/sessions/s1')).json();
    expect(body.messages).toHaveLength(5);
    expect(body.page).toBeUndefined();
  });
  test('the last N, then the N before a message', async () => {
    const end = await (await get('/api/sessions/s1?last=2')).json();
    expect(end.messages.map((m: { id: string }) => m.id)).toEqual(['m3', 'm4']);
    expect(end.page).toEqual({ before: 'm3', total: 5 });
    const before = await (await get('/api/sessions/s1?before=m3&limit=2')).json();
    expect(before.messages.map((m: { id: string }) => m.id)).toEqual(['m1', 'm2']);
  });
  test('refuses a bad page, and says when the message is gone', async () => {
    expect((await get('/api/sessions/s1?last=0')).status).toBe(400);
    expect((await get('/api/sessions/s1?limit=2')).status).toBe(400);
    const gone = await get('/api/sessions/s1?before=nope&limit=2');
    expect(gone.status).toBe(404);
    expect((await gone.json()).error).toMatch(/no longer in the conversation/);
  });
});

describe('what the user has looked at', () => {
  const post = (body: unknown) => fetch(`${base}/api/seen`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify(body) });

  test('one record, changed through one action and pushed to every window', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`, { origin: ORIGIN });
    const pushed: any[] = [];
    socket.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === 'seen') pushed.push(m.seen);
    });
    await new Promise((resolve) => socket.once('open', resolve));
    try {
      await expect.poll(() => pushed.length).toBe(1);
      expect(pushed[0]).toHaveProperty('s1');
      expect((await (await post({ sessionIds: ['s1'], unread: true })).json()).seen.s1).toBe(0);
      await expect.poll(() => pushed.at(-1)?.s1).toBe(0);
      expect((await (await post({ sessionIds: ['s1'] })).json()).seen.s1).toBeGreaterThan(0);
      await expect.poll(() => pushed.at(-1)?.s1).toBeGreaterThan(0);
      expect((await (await fetch(`${base}/api/seen`, { headers: auth })).json()).seen.s1).toBeGreaterThan(0);
    } finally {
      socket.close();
    }
  });

  test('refuses a malformed change, and is never kept in the window\'s ui-state again', async () => {
    expect((await post({ sessionIds: 's1' })).status).toBe(400);
    expect((await post({ sessionIds: ['s1', 's2'], unread: true })).status).toBe(400);
    await ws.setUiState(JSON.stringify({ seen: { s1: 7 } }));
    const put = await fetch(`${base}/api/ui-state`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ tabs: {}, seen: { s1: 1 } }) });
    expect(put.status).toBe(204);
    expect(JSON.parse((await ws.getUiState())!).seen).toBeUndefined();
    // What the older window kept was moved into the record before the write, not lost.
    expect((await ws.seen.view()).s1).toBe(7);
  });
});

describe('access rules', () => {
  test('binds to loopback only', () => {
    expect((app.server.address() as AddressInfo).address).toBe('127.0.0.1');
  });
  test('refuses a request without the launch token', async () => {
    expect((await fetch(`${base}/api/state`)).status).toBe(401);
    expect((await fetch(`${base}/api/state`, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
  });
  test('refuses another Origin even with the right token', async () => {
    const res = await fetch(`${base}/api/state`, { headers: { ...auth, Origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
  test('refuses a Host header that is not this server (DNS rebinding)', async () => {
    // fetch refuses to forge Host, so send the request by hand.
    const status = await new Promise<number>((resolve, reject) => {
      request({ host: '127.0.0.1', port, path: '/api/state', headers: { ...auth, Host: `evil.example:${port}` } }, (res) => (res.resume(), resolve(res.statusCode ?? 0)))
        .on('error', reject)
        .end();
    });
    expect(status).toBe(403);
  });
  test('serves the app origin with the token', async () => {
    const res = await fetch(`${base}/api/state`, { headers: { ...auth, Origin: ORIGIN } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect((await res.json()).sessions).toHaveLength(1);
  });
  test('refuses a WebSocket without the token or from another origin', async () => {
    const attempt = (url: string, origin?: string) =>
      new Promise<string>((resolve) => {
        const socket = new WebSocket(url, { origin });
        socket.on('open', () => (socket.close(), resolve('open')));
        socket.on('error', () => resolve('refused'));
      });
    expect(await attempt(`ws://127.0.0.1:${port}/ws`)).toBe('refused');
    expect(await attempt(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`, 'https://evil.example')).toBe('refused');
    expect(await attempt(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`, ORIGIN)).toBe('open');
  });
});

describe('api', () => {
  const post = (path: string, body: unknown, method = 'POST') => fetch(`${base}${path}`, { method, headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  test('the delegation limits are read and set by the user only, with a reason for a value out of range', async () => {
    const view = await fetch(`${base}/api/delegation-limits`, { headers: auth });
    expect(await view.json()).toEqual({ limits: { maxChildrenPerDelegate: 5, maxDepth: 2, maxLiveSessionsPerTree: 10 }, defaults: { maxChildrenPerDelegate: 5, maxDepth: 2, maxLiveSessionsPerTree: 10 } });
    const bad = await post('/api/delegation-limits', { maxChildrenPerDelegate: 5, maxDepth: 2, maxLiveSessionsPerTree: 31 }, 'PUT');
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/from 1 to 30; 31 is outside/);
    expect((await post('/api/delegation-limits', { maxChildrenPerDelegate: 3, maxDepth: 2, maxLiveSessionsPerTree: 10 }, 'PUT')).status).toBe(200);
    expect((await ws.limits.current()).maxChildrenPerDelegate).toBe(3);
    // A session's own token (what its agent's tool server holds) does not reach it.
    const asAgent = await fetch(`${base}/api/delegation-limits`, { method: 'PUT', headers: { Authorization: `Bearer ${sessionToken(TOKEN, 's1')}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ maxChildrenPerDelegate: 10, maxDepth: 4, maxLiveSessionsPerTree: 30 }) });
    expect(asAgent.status).toBe(401);
    expect((await ws.limits.current()).maxChildrenPerDelegate).toBe(3);
  });

  test('rejects invalid input with a reason', async () => {
    const res = await post('/api/sessions', { title: '  ', agent: 'claude' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/title/);
    expect((await post('/api/sessions', { title: 'x', agent: 'gpt' })).status).toBe(400);
  });
  test('an unknown agent is refused, naming the agents there are', async () => {
    const res = await post('/api/sessions', { title: 'x', agent: 'gpt' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('agent must be claude, codex, opencode');
  });
  test('a workstream is renamed, described, thinned and deleted, and its sessions are left alone', async () => {
    await ws.addProject({ id: 'docs-http', name: 'Docs', path: '/d', isGit: true });
    const { workstream, children } = await ws.delegate('s1', [{ projectId: 'docs-http', brief: 'Write it up' }], { name: 'Launch notes' });
    const id = workstream!.id;
    try {
      expect((await post(`/api/workstreams/${id}`, { name: ' Release notes ', objective: 'Say what shipped.' }, 'PATCH')).status).toBe(204);
      expect((await ws.state()).workstreams[0]).toMatchObject({ name: 'Release notes', objective: 'Say what shipped.' });
      // Restoring with `sessions: true` brings back a session archived with it.
      await ws.setState(children[0]!.id, 'done');
      await ws.setArchived('session', children[0]!.id, true);
      // Not while a session in it is still at work: refused with the reason (Matt, 2026-11-19).
      const busy = await post(`/api/workstreams/${id}`, { archived: true }, 'PATCH');
      expect(busy.status).toBe(409);
      expect((await busy.json()).error).toMatch(/can be archived once its sessions are done/);
      await ws.setState('s1', 'done');
      expect((await post(`/api/workstreams/${id}`, { archived: true }, 'PATCH')).status).toBe(204);
      expect((await post(`/api/workstreams/${id}`, { archived: false, sessions: true }, 'PATCH')).status).toBe(204);
      expect((await ws.state()).workstreams[0]!.sessionIds).toContain(children[0]!.id);
      const blank = await post(`/api/workstreams/${id}`, { name: '   ' }, 'PATCH');
      expect(blank.status).toBe(400);
      const missing = await post('/api/workstreams/nope', { name: 'x' }, 'PATCH');
      expect(missing.status).toBe(409);
      expect((await missing.json()).error).toBe('No such workstream.');
      const removed = await fetch(`${base}/api/workstreams/${id}/sessions/${children[0]!.id}`, { method: 'DELETE', headers: auth });
      expect(removed.status).toBe(200);
      expect(await removed.json()).toEqual({ index: 1 });
      expect((await ws.state()).workstreams[0]!.sessionIds).toEqual(['s1']);
      const putBack = (body: unknown) => fetch(`${base}/api/workstreams/${id}/sessions`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect((await putBack({ sessionId: children[0]!.id, index: 'one' })).status).toBe(400);
      expect((await putBack({ sessionId: children[0]!.id, index: 1 })).status).toBe(204);
      expect((await ws.state()).workstreams[0]!.sessionIds).toEqual(['s1', children[0]!.id]);
      const lead = await fetch(`${base}/api/workstreams/${id}/sessions/s1`, { method: 'DELETE', headers: auth });
      expect(lead.status).toBe(409);
      expect((await lead.json()).error).toMatch(/leads this workstream/);
      expect((await fetch(`${base}/api/workstreams/${id}`, { method: 'DELETE', headers: auth })).status).toBe(204);
      expect((await ws.state()).workstreams).toEqual([]);
      expect((await ws.state()).sessions.map((x) => x.id)).toContain(children[0]!.id);
    } finally {
      await ws.setState(children[0]!.id, 'done');
      await ws.deleteSession(children[0]!.id);
      // Gone already when the test reached its own DELETE; deleting an unknown one is refused.
      await ws.deleteWorkstream(id).catch(() => undefined);
    }
  });

  test('a refused operation comes back as 409 with the reason', async () => {
    const res = await post('/api/sessions/s1/move', { groupId: 'missing' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('No such group.');
  });
  // Writes that arrive close together are sent to a socket as fewer messages than there were
  // writes, and the last message always carries the final state. How many messages that is
  // depends on timing, so this checks only what must hold however slow the machine is: the
  // socket ends up with the final state, and never receives more messages than writes.
  test('a burst of writes reaches a socket with the final state, in no more messages than writes', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`, { origin: ORIGIN });
    const states: any[] = [];
    let wanted: ((state: any) => boolean) | null = null;
    let found: (() => void) | null = null;
    socket.on('message', (data) => {
      const message = JSON.parse(String(data));
      if (message.type !== 'state') return;
      states.push(message.state);
      if (wanted?.(message.state)) found?.();
    });
    /** Resolves when a state matching `check` has arrived, whether it already has or comes later. */
    const until = (check: (state: any) => boolean) =>
      new Promise<void>((resolve) => {
        if (states.some(check)) return resolve();
        wanted = check;
        found = resolve;
      });
    await until(() => true); // the state sent on connect
    const before = states.length;
    const group = await (await post('/api/groups', { name: 'Launch' })).json();
    await post('/api/sessions/s1/move', { groupId: group.id });
    await post(`/api/groups/${group.id}`, { name: 'Launch 2' }, 'PATCH');
    await until((state) => state.groups.some((g: any) => g.name === 'Launch 2') && state.sessions[0].groupId === group.id);
    socket.close();
    const final = states.at(-1);
    expect(final.groups).toMatchObject([{ name: 'Launch 2' }]);
    expect(final.sessions[0].groupId).toBe(group.id);
    const WRITES = 3;
    expect(states.length - before).toBeGreaterThanOrEqual(1);
    expect(states.length - before).toBeLessThanOrEqual(WRITES);
  });
});

describe('pictures', () => {
  let picApp: KestrelServer;
  let picBase: string;
  let outsidePng: string;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]);

  beforeEach(async () => {
    const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-http-data-')));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-http-folder-')));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-http-outside-')));
    writeFileSync(join(folder, 'chart.png'), png);
    writeFileSync(join(folder, 'logo.svg'), '<svg/>');
    writeFileSync(join(folder, 'notes.txt'), 'hi');
    writeFileSync(join(outside, 'x.png'), png);
    mkdirSync(join(data, 'media', 's2'), { recursive: true });
    writeFileSync(join(data, 'media', 's2', 'tool_1-0.png'), png);
    const w = new Workspace(memoryPersistence());
    await w.addProject({ id: 'plain', name: 'Plain', path: folder, isGit: false });
    await w.addSession({ id: 's2', title: 'Two', agent: 'claude', startedIn: 'plain' });
    const policy = { token: TOKEN, allowedOrigins: [ORIGIN], port: 0 };
    picApp = createKestrelServer(w, policy, new SessionRuntime(w, {}, data));
    await picApp.listen();
    policy.port = (picApp.server.address() as AddressInfo).port;
    picBase = `http://127.0.0.1:${policy.port}/api/sessions/s2`;
    outsidePng = join(outside, 'x.png');
  });
  afterEach(() => picApp.close());

  test('serves a stored picture with its type, to the token holder only', async () => {
    const res = await fetch(`${picBase}/media/tool_1-0.png`, { headers: { ...auth, Origin: ORIGIN } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(png);
    expect((await fetch(`${picBase}/media/tool_1-0.png`)).status).toBe(401);
    expect((await fetch(`${picBase}/media/nope.png`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${picBase}/media/..%2Fx.png`, { headers: auth })).status).toBe(404);
  });

  test('serves image files inside the session folder, and nothing else', async () => {
    const raw = (path: string) => fetch(`${picBase}/raw?path=${encodeURIComponent(path)}`, { headers: auth });
    const ok = await raw('chart.png');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect((await raw('logo.svg')).headers.get('content-type')).toBe('image/svg+xml');
    expect((await raw('notes.txt')).status).toBe(400);
    expect((await raw(outsidePng)).status).toBe(404);
    expect((await raw('../x.png')).status).toBe(404);
  });

  test('passes question answers through, and rejects malformed ones', async () => {
    const post = (body: unknown) => fetch(`${picBase}/answer`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post({ requestId: 'q', answers: ['a'] })).status).toBe(400);
    expect((await post({ requestId: 'q', answers: { 'a?': 3 } })).status).toBe(400);
    expect((await post({ requestId: 'q', answers: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`q${i}`, 'x'])) })).status).toBe(400);
    // Well-formed answers reach the runtime, which has nothing waiting here.
    expect((await post({ requestId: 'q', answers: { 'a?': 'b' } })).status).toBe(409);
  });

  test('routes the queue: send now and remove reach the runtime, which refuses with a reason here', async () => {
    const sendNow = await fetch(`${picBase}/queue/send`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' });
    expect(sendNow.status).toBe(409);
    expect((await sendNow.json()).error).toMatch(/no agent behind it/);
    const remove = await fetch(`${picBase}/queue/queued-1`, { method: 'DELETE', headers: auth });
    expect(remove.status).toBe(409);
  });

  test('routes stopping background work to the runtime, which refuses an unknown session or task', async () => {
    const stop = (base: string, task: string) => fetch(`${base}/background-tasks/${encodeURIComponent(task)}/stop`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' });
    const unknownTask = await stop(picBase, 'task 1');
    expect(unknownTask.status).toBe(409);
    expect((await unknownTask.json()).error).toMatch(/no longer running/);
    const unknownSession = await stop(picBase.replace(/s2$/, 'nope'), 'task-1');
    expect(unknownSession.status).toBe(409);
    expect((await unknownSession.json()).error).toMatch(/No such session/);
  });

  test('routes forking to the runtime, which refuses with the reason when it cannot fork', async () => {
    const fork = (url: string) => fetch(`${url}/fork`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' });
    const cannot = await fork(picBase);
    expect(cannot.status).toBe(409);
    expect((await cannot.json()).error).toMatch(/^Cannot fork “Two”/);
    const unknown = await fork(picBase.replace(/s2$/, 'nope'));
    expect(unknown.status).toBe(409);
    expect((await unknown.json()).error).toMatch(/No such session/);
    // A turn to fork from must be an id.
    const bad = await fetch(`${picBase}/fork`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ turn: 42 }) });
    expect(bad.status).toBe(400);
  });
});

describe('terminals over the socket', () => {
  let termApp: KestrelServer;
  let termPort: number;
  let shells: ReturnType<typeof fakePty>['spawned'];
  let folder: string;
  let repo: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-term-data-')));
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-term-folder-')));
    repo = makeRepo();
    const w = new Workspace(memoryPersistence());
    await w.addProject({ id: 'plain', name: 'Plain', path: folder, isGit: false });
    await w.addProject({ id: 'repo', name: 'Repo', path: repo, isGit: true });
    await w.addGroup('Errands', { id: 'g1' });
    await w.addSession({ id: 's3', title: 'Three', agent: 'claude', startedIn: 'plain', state: 'done' });
    const fake = fakePty();
    shells = fake.spawned;
    const policy = { token: TOKEN, allowedOrigins: [ORIGIN], port: 0 };
    termApp = createKestrelServer(w, policy, new SessionRuntime(w, {}, data), { terminals: new Terminals(fake.spawn, { SHELL: '/bin/zsh' }, { titleCheckMs: 0 }) });
    await termApp.listen();
    termPort = (termApp.server.address() as AddressInfo).port;
    policy.port = termPort;
  });
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close();
    await termApp.close();
  });

  /** A socket that records every terminal message and can wait for one matching a check. */
  async function connect() {
    const socket = new WebSocket(`ws://127.0.0.1:${termPort}/ws?token=${TOKEN}`, { origin: ORIGIN });
    sockets.push(socket);
    const got: any[] = [];
    const waiting: { check: (m: any) => boolean; resolve: (m: any) => void }[] = [];
    socket.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (!String(m.type).startsWith('term-')) return;
      got.push(m);
      for (const w of waiting.splice(0)) (w.check(m) ? w.resolve(m) : waiting.push(w));
    });
    await new Promise((resolve) => socket.once('open', resolve));
    /** The first message matching `check` from index `since` on, whether it has arrived or comes later. */
    const until = (check: (m: any) => boolean, since = 0) => new Promise<any>((resolve) => {
      const seen = got.slice(since).find(check);
      if (seen) resolve(seen);
      else waiting.push({ check, resolve });
    });
    const send = (m: object, scope = 's3') => socket.send(JSON.stringify({ sessionId: scope, ...m }));
    return { got, until, send, mark: () => got.length };
  }
  const listOf = (n: number) => (m: any) => m.type === 'term-list' && m.terminals.length === n;

  test('several terminals per session, listed again after reconnecting, with their output replayed', async () => {
    const a = await connect();
    a.send({ type: 'term-new', cols: 80, rows: 24 });
    const first = await a.until((m) => m.type === 'term-created');
    a.send({ type: 'term-new', cols: 80, rows: 24 });
    const second = await a.until((m) => m.type === 'term-created' && m.terminalId !== first.terminalId);
    a.send({ type: 'term-open', terminalId: first.terminalId, cols: 80, rows: 24 });
    shells[0]!.emit('hello from one');
    await a.until((m) => m.type === 'term-data' && m.terminalId === first.terminalId && m.data === 'hello from one');
    a.send({ type: 'term-input', terminalId: first.terminalId, data: 'ls\r' });
    a.send({ type: 'term-input', terminalId: second.terminalId, data: 'not attached, so dropped' });

    // A new socket (a reload, or a reconnect) finds both, and the first one's output.
    const b = await connect();
    b.send({ type: 'term-list' });
    const listed = await b.until(listOf(2));
    expect(listed.terminals).toMatchObject([{ id: first.terminalId, title: 'zsh', exited: false }, { id: second.terminalId, title: 'zsh 2', exited: false }]);
    b.send({ type: 'term-open', terminalId: first.terminalId, cols: 100, rows: 30 });
    const replay = await b.until((m) => m.type === 'term-data' && m.terminalId === first.terminalId);
    expect(replay.data).toBe('hello from one');
    expect(shells[0]!.written).toEqual(['ls\r']);
    expect(shells[1]!.written).toEqual([]);

    // Closing a tab ends that shell and every listing socket hears of it.
    const beforeKill = a.mark();
    b.send({ type: 'term-kill', terminalId: second.terminalId });
    await a.until(listOf(1), beforeKill);
    expect(shells[1]!.killed).toBe(true);

    // An exited shell stays listed, marked, until its tab is closed.
    shells[0]!.end(0);
    const exit = await b.until((m) => m.type === 'term-exit');
    expect(exit).toMatchObject({ terminalId: first.terminalId, code: 0 });
    const after = await b.until((m) => m.type === 'term-list' && m.terminals[0]?.exited);
    expect(after.terminals).toMatchObject([{ id: first.terminalId, exited: true, exitCode: 0 }]);
  });

  test('refuses a ninth terminal with a reason, and renames a tab', async () => {
    const a = await connect();
    for (let i = 0; i < 8; i++) a.send({ type: 'term-new' });
    await a.until(listOf(8));
    a.send({ type: 'term-new' });
    const refused = await a.until((m) => m.type === 'term-error');
    expect(refused.message).toMatch(/at most 8 terminals/);
    const id = a.got.find((m) => m.type === 'term-created').terminalId;
    a.send({ type: 'term-rename', terminalId: id, title: 'server' });
    const renamed = await a.until((m) => m.type === 'term-list' && m.terminals.some((t: any) => t.title === 'server'));
    expect(renamed.terminals.find((t: any) => t.id === id)).toMatchObject({ title: 'server', renamed: true });
  });

  test('moves a tab beside another', async () => {
    const a = await connect();
    a.send({ type: 'term-new' });
    a.send({ type: 'term-new' });
    const listed = await a.until(listOf(2));
    const [first, second] = listed.terminals.map((t: any) => t.id);
    a.send({ type: 'term-move', terminalId: second, target: first, after: false });
    const moved = await a.until((m) => m.type === 'term-list' && m.terminals[0]?.id === second);
    expect(moved.terminals.map((t: any) => t.id)).toEqual([second, first]);
  });

  test('deleting the session kills all of its terminals', async () => {
    const a = await connect();
    a.send({ type: 'term-new' });
    a.send({ type: 'term-new' });
    await a.until(listOf(2));
    const res = await fetch(`http://127.0.0.1:${termPort}/api/sessions/s3`, { method: 'DELETE', headers: auth });
    expect(res.status).toBe(204);
    await a.until(listOf(0), 1);
    expect(shells.map((s) => s.killed)).toEqual([true, true]);
  });

  const get = (path: string) => fetch(`http://127.0.0.1:${termPort}${path}`, { headers: auth });

  test('a project page’s shells open in the project folder and are its own', async () => {
    const a = await connect();
    a.send({ type: 'term-new' }, 'project:repo');
    const created = await a.until((m) => m.type === 'term-created');
    expect(created.sessionId).toBe('project:repo');
    expect(shells[0]!.options.cwd).toBe(repo);
    a.send({ type: 'term-list' });
    expect((await a.until((m) => m.type === 'term-list' && m.sessionId === 's3')).terminals).toEqual([]);
  });

  test('a group has no folder, so its shells open in the home folder', async () => {
    const a = await connect();
    a.send({ type: 'term-new' }, 'group:g1');
    await a.until((m) => m.type === 'term-created' && m.sessionId === 'group:g1');
    expect(shells[0]!.options.cwd).toBe(homedir());
  });

  test('session: and a bare id are the same session', async () => {
    const a = await connect();
    a.send({ type: 'term-new' }, 'session:s3');
    await a.until((m) => m.type === 'term-created' && m.sessionId === 's3');
    a.send({ type: 'term-list' });
    expect((await a.until(listOf(1))).sessionId).toBe('s3');
  });

  test('deleting a project or a group kills its shells', async () => {
    const a = await connect();
    a.send({ type: 'term-new' }, 'project:plain-2');
    await a.until((m) => m.type === 'term-error' && m.sessionId === 'project:plain-2');
    a.send({ type: 'term-new' }, 'group:g1');
    a.send({ type: 'term-new' }, 'project:repo');
    await a.until((m) => m.type === 'term-created' && m.sessionId === 'project:repo');
    await a.until((m) => m.type === 'term-created' && m.sessionId === 'group:g1');
    expect((await fetch(`http://127.0.0.1:${termPort}/api/groups/g1`, { method: 'DELETE', headers: auth })).status).toBe(204);
    expect((await fetch(`http://127.0.0.1:${termPort}/api/projects/repo`, { method: 'DELETE', headers: auth })).status).toBe(204);
    await a.until((m) => m.type === 'term-list' && m.sessionId === 'project:repo' && m.terminals.length === 0);
    expect(shells.map((s) => s.killed)).toEqual([true, true]);
  });

  test('Files lists a project page’s folder; a group has none', async () => {
    writeFileSync(join(folder, 'note.md'), 'hi');
    const listing = await (await get('/api/scopes/project:plain/files?path=')).json();
    expect(listing.root).toBe(folder);
    expect(listing.entries.map((e: any) => e.name)).toEqual(['note.md']);
    // The UI encodes the key's colon.
    expect((await (await get('/api/scopes/project%3Aplain/files?path=')).json()).root).toBe(folder);
    expect(await (await get('/api/scopes/project:plain/file?path=note.md')).json()).toMatchObject({ kind: 'text', text: 'hi' });
    const group = await get('/api/scopes/group:g1/files?path=');
    expect(group.status).toBe(404);
    expect((await group.json()).error).toBe('A group has no folder.');
    expect((await get('/api/scopes/planet:x/files?path=')).status).toBe(404);
    // A session's Files still answer on both routes.
    expect((await (await get('/api/scopes/s3/files?path=')).json()).root).toBe(folder);
    expect((await (await get('/api/sessions/s3/files?path=')).json()).root).toBe(folder);
  });

  test('a project page’s Changes are the main checkout’s uncommitted edits', async () => {
    // A different size, so git sees the edit from the file's size alone: a same-size rewrite in the
    // same clock tick as the commit is git's "racily clean" case, which a loaded machine can hit.
    writeFileSync(join(repo, 'a.txt'), 'two lines\n');
    writeFileSync(join(repo, 'new.txt'), 'fresh\n');
    const changes = await (await get('/api/projects/repo/changes')).json();
    expect(changes).toMatchObject({ isGit: true, branch: 'main', note: null });
    expect(changes.files.map((f: any) => [f.path, f.status])).toEqual([['a.txt', 'M'], ['new.txt', 'A']]);
    expect(changes.files[0].diff).toMatch(/-one\n\+two/);
    expect(await (await get('/api/projects/plain/changes')).json()).toEqual({ isGit: false, branch: null, files: [], note: 'Not a git repository', folderId: 'plain' });
    expect((await get('/api/projects/nope/changes')).status).toBe(404);
  });
});

describe('the browser pane over the socket', () => {
  let browserApp: KestrelServer;
  let browserPort: number;
  let runtime: SessionRuntime;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-browser-data-')));
    const w = new Workspace(memoryPersistence());
    runtime = new SessionRuntime(w, {}, data);
    const policy = { token: TOKEN, allowedOrigins: [ORIGIN], port: 0 };
    browserApp = createKestrelServer(w, policy, runtime);
    await browserApp.listen();
    browserPort = (browserApp.server.address() as AddressInfo).port;
    policy.port = browserPort;
  });
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close();
    await browserApp.close();
  });

  test('a window that shows the session performs the call and its answer reaches the agent', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${browserPort}/ws?token=${TOKEN}`, { origin: ORIGIN });
    sockets.push(socket);
    await new Promise((resolve) => socket.once('open', resolve));
    socket.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === 'browser-request' && m.op === 'console') socket.send(JSON.stringify({ type: 'browser-response', requestId: m.requestId, ok: true, result: { url: 'https://example.com/', title: 'Example', entries: [{ level: 'info', text: 'hi', at: 0 }] } }));
    });
    socket.send(JSON.stringify({ type: 'browser-serve', sessionId: 's1', capable: true }));
    // The serve message is on its way; the request waits for it rather than failing.
    const result = await runtime.browser.hostFor('s1').browserConsole();
    expect(result.text).toContain('[info] --:--:-- hi');
  });

  test("an agent cannot point the pane at Kestrel's own server", async () => {
    const result = await runtime.browser.hostFor('s1').browserNavigate({ url: `http://127.0.0.1:${browserPort}/api/state` });
    expect(result).toMatchObject({ isError: true, text: expect.stringMatching(/own server/) });
  });
});

describe('merge route registration', () => {
  test('routes preview and confirmation to the merge handler', async () => {
    for (const action of ['pr-merge-preview', 'pr-merge']) {
      const res = await fetch(`${base}/api/sessions/missing/${action}`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ number: 181 }) });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'No such session' });
    }
  });
});
