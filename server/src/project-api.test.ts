// The project routes over HTTP: refusals come back as 409 with the field they concern, malformed
// input as 400, and the older routes keep answering as before.
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createKestrelServer, type KestrelServer } from './http.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { SessionRuntime } from './runtime.ts';
import { Workspace } from './workspace.ts';

const TOKEN = 'test-token';
let app: KestrelServer;
let base: string;
let dirs: string;

beforeEach(async () => {
  const ws = new Workspace(memoryPersistence());
  dirs = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-api-')));
  const runtime = new SessionRuntime(ws, {}, join(dirs, 'data'));
  const policy = { token: TOKEN, allowedOrigins: [], port: 0 };
  app = createKestrelServer(ws, policy, runtime);
  await app.listen();
  policy.port = (app.server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${policy.port}`;
});
afterEach(() => app.close());

const call = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
  const res = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};
const dir = (name: string) => {
  const path = join(dirs, name);
  mkdirSync(path);
  return path;
};

describe('project routes', () => {
  test('create, add, reorder and remove directories', async () => {
    const created = await call('/api/projects/create', { name: 'Ideas' });
    expect(created).toMatchObject({ status: 201, body: { name: 'Ideas', folders: [] } });
    const id = created.body.id;
    await call(`/api/projects/${id}/folders`, { path: dir('a') });
    const two = await call(`/api/projects/${id}/folders`, { path: dir('b') });
    expect(two.status).toBe(201);
    const [a, b] = two.body.folders.map((f: { id: string }) => f.id);
    const order = await call(`/api/projects/${id}/folders/order`, { folders: [b, a] });
    expect(order.body.folders.map((f: { id: string }) => f.id)).toEqual([b, a]);
    const removed = await call(`/api/projects/${id}/folders/${b}`, undefined, 'DELETE');
    expect(removed.body.folders.map((f: { id: string }) => f.id)).toEqual([a]);
    expect((await call(`/api/projects/${id}/changes`)).body).toMatchObject({ isGit: false, folderId: a });
  });

  test('the default folder is chosen explicitly, on create or later, and reordering leaves it', async () => {
    const [x, y] = [dir('x'), dir('y')];
    const created = await call('/api/projects/create', { name: 'Two', folders: [x, y], defaultFolder: y });
    const [fx, fy] = created.body.folders.map((f: { id: string }) => f.id);
    expect(created.body.defaultFolderId).toBe(fy);
    const id = created.body.id;
    expect((await call(`/api/projects/${id}/folders/order`, { folders: [fy, fx] })).body.defaultFolderId).toBe(fy);
    expect((await call(`/api/projects/${id}/folders/default`, { folderId: fx })).body.defaultFolderId).toBe(fx);
    expect((await call(`/api/projects/${id}/changes`)).body.folderId).toBe(fx);
    expect(await call(`/api/projects/${id}/folders/default`, { folderId: 'nope' })).toEqual({ status: 409, body: { error: 'That folder is not in this project.' } });
    expect((await call(`/api/projects/${id}/folders/default`, {})).status).toBe(400);
    expect((await call(`/api/projects/${id}/folders/${fx}`, undefined, 'DELETE')).body.defaultFolderId).toBe(fy);
  });

  test('a project created without a chosen default gets its first folder', async () => {
    const created = await call('/api/projects/create', { name: 'One', folders: [dir('first'), dir('second')] });
    expect(created.body.defaultFolderId).toBe(created.body.folders[0].id);
  });

  test('a refusal names the field it is about', async () => {
    await call('/api/projects/create', { name: 'Shop' });
    expect(await call('/api/projects/create', { name: 'shop' })).toEqual({ status: 409, body: { error: 'There is already a project called Shop.', field: 'name' } });
    const missing = join(dirs, 'missing');
    expect(await call('/api/projects/create', { name: 'X', folders: [missing] })).toEqual({ status: 409, body: { error: `${missing} is not a folder that exists.`, field: missing } });
  });

  test('checks a directory before a project exists, saving nothing', async () => {
    const path = dir('checked');
    expect(await call('/api/projects/check-folder', { path })).toEqual({ status: 200, body: { path, isGit: false } });
    await call('/api/projects/create', { name: 'Has it', folders: [path] });
    expect(await call('/api/projects/check-folder', { path })).toEqual({ status: 409, body: { error: `${path} is already in the project Has it.`, field: path } });
  });

  test('malformed input is a 400', async () => {
    expect((await call('/api/projects/create', { name: 'X', folders: 'nope' })).status).toBe(400);
    expect((await call('/api/projects/create', { folders: [] })).status).toBe(400);
    const { body } = await call('/api/projects/create', { name: 'Y' });
    expect((await call(`/api/projects/${body.id}/folders/order`, { folders: [1] })).status).toBe(400);
    expect((await call(`/api/projects/${body.id}/folders`, {})).status).toBe(400);
  });

  test('ensure-by-path and the older register route still answer as before', async () => {
    const path = dir('older');
    const first = await call('/api/projects/ensure', { path });
    expect(first).toMatchObject({ status: 200, body: { created: true, project: { name: 'older', folders: [{ path }] } } });
    expect((await call('/api/projects/ensure', { path })).body).toEqual({ created: false, project: first.body.project });
    expect(await call('/api/projects', { path: dir('named'), name: 'Named' })).toMatchObject({ status: 201, body: { name: 'Named' } });
  });
});
