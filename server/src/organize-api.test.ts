import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createKestrelServer, type KestrelServer } from './http.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { Workspace } from './workspace.ts';

const TOKEN = 'test-token';
const ORIGIN = 'http://localhost:5173';
let app: KestrelServer;
let ws: Workspace;
let base: string;

beforeEach(async () => {
  ws = new Workspace(memoryPersistence());
  await ws.addProject({ id: 'bellbird', name: 'Bellbird', path: '/b', isGit: true });
  await ws.addSession({ id: 's1', title: 'One', agent: 'claude', startedIn: 'bellbird' });
  const policy = { token: TOKEN, allowedOrigins: [ORIGIN], port: 0 };
  app = createKestrelServer(ws, policy);
  await app.listen();
  policy.port = (app.server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${policy.port}`;
});
afterEach(() => app.close());

const call = (path: string, method: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

describe('tag routes', () => {
  test('add a tag and take it off; the state shows them on the session', async () => {
    const added = await call('/api/sessions/s1/tags', 'POST', { tag: ' PLAT-1234 ' });
    expect(added.status).toBe(200);
    expect(await added.json()).toEqual({ tags: ['PLAT-1234'] });
    await call('/api/sessions/s1/tags', 'POST', { tag: 'release train' });
    const state = await (await call('/api/state', 'GET')).json();
    expect(state.sessions[0].tags).toEqual(['PLAT-1234', 'release train']);

    const removed = await call(`/api/sessions/s1/tags/${encodeURIComponent('Release Train')}`, 'DELETE');
    expect(await removed.json()).toEqual({ tags: ['PLAT-1234'] });
  });

  test('a bad tag is a 400 with the reason; a missing session a 409', async () => {
    const empty = await call('/api/sessions/s1/tags', 'POST', { tag: '  ' });
    expect(empty.status).toBe(400);
    expect((await empty.json()).error).toMatch(/Write the tag/);
    expect((await call('/api/sessions/s1/tags', 'POST', { tag: 'x'.repeat(41) })).status).toBe(400);
    expect((await call('/api/sessions/s1/tags', 'POST', {})).status).toBe(400);
    expect((await call('/api/sessions/missing/tags', 'POST', { tag: 'x' })).status).toBe(409);
    expect((await call('/api/sessions/s1/tags/%E0%A4%A', 'DELETE')).status).toBe(400);
  });
});

describe('pin routes', () => {
  test('pin and unpin; the state lists what is pinned', async () => {
    expect((await call('/api/pins', 'POST', { kind: 'session', id: 's1' })).status).toBe(204);
    expect((await (await call('/api/state', 'GET')).json()).pins).toMatchObject([{ kind: 'session', id: 's1' }]);
    expect((await call('/api/pins', 'POST', { kind: 'session', id: 's1', pinned: false })).status).toBe(204);
    expect((await (await call('/api/state', 'GET')).json()).pins).toEqual([]);
  });

  test('reorder: a full list of the pins is taken; a partial, padded or malformed one is not', async () => {
    await ws.addSession({ id: 's2', title: 'Two', agent: 'claude', startedIn: 'bellbird' });
    await call('/api/pins', 'POST', { kind: 'session', id: 's1' });
    await call('/api/pins', 'POST', { kind: 'project', id: 'bellbird' });
    await call('/api/pins', 'POST', { kind: 'session', id: 's2' });
    const order = [{ kind: 'session', id: 's2' }, { kind: 'session', id: 's1' }, { kind: 'project', id: 'bellbird' }];
    expect((await call('/api/pins/order', 'POST', { pins: order })).status).toBe(204);
    expect((await (await call('/api/state', 'GET')).json()).pins.map((p: { id: string }) => p.id)).toEqual(['s2', 's1', 'bellbird']);
    expect((await call('/api/pins/order', 'POST', { pins: order.slice(1) })).status).toBe(409);
    expect((await call('/api/pins/order', 'POST', { pins: [...order, order[0]] })).status).toBe(400);
    expect((await call('/api/pins/order', 'POST', { pins: 'nope' })).status).toBe(400);
    expect((await call('/api/pins/order', 'POST', {})).status).toBe(400);
  });

  test('a bad kind or id is a 400; a missing item a 409', async () => {
    expect((await call('/api/pins', 'POST', { kind: 'folder', id: 's1' })).status).toBe(400);
    expect((await call('/api/pins', 'POST', { kind: 'session' })).status).toBe(400);
    expect((await call('/api/pins', 'POST', { kind: 'project', id: 'nope' })).status).toBe(409);
  });
});
