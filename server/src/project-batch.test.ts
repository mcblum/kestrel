// Several projects from one parent folder: listing its subfolders, and creating projects for many of
// them in one request, each through the same path as a single add.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import { listFolder } from './folder-listing.ts';
import { createKestrelServer, type KestrelServer } from './http.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { createProjects } from './project-batch.ts';
import { createProject } from './project-store.ts';
import { SessionRuntime } from './runtime.ts';
import { PROJECT_BATCH_LIMITS } from './shared/folder-batch.ts';
import { Refused, Workspace } from './workspace.ts';

// Builds real git repositories: room under a loaded machine (test-timeouts.ts).
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

let root: string;
let workspace: Workspace;
const locked: string[] = [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-batch-')));
  workspace = new Workspace(memoryPersistence());
});
afterEach(() => {
  // Put permissions back so the temp folder can be cleaned up.
  for (const path of locked.splice(0)) chmodSync(path, 0o755);
});

const folder = (...parts: string[]) => {
  const path = join(root, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
};
const repo = (...parts: string[]) => {
  const path = folder(...parts);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: path, stdio: 'ignore' });
  return path;
};
const unreadable = (...parts: string[]) => {
  const path = folder(...parts);
  chmodSync(path, 0o000);
  locked.push(path);
  return path;
};
/**
 * Root may open any folder whatever its permissions say, so a folder cannot be made unreadable for
 * it: CI runs the tests as root in a container. What happens to an unreadable folder is tested
 * where one can exist.
 */
const asRoot = process.getuid?.() === 0;

const projects = async () => {
  const state = await workspace.state();
  return [...state.projects, ...state.archived.projects];
};
const listing = async (path: string) => listFolder(path, await projects());

describe('listing a folder', () => {
  test('marks git repositories, plain folders and registered ones, and skips hidden folders and files', async () => {
    const parent = folder('code');
    repo('code', 'web');
    folder('code', 'notes');
    folder('code', '.cache');
    writeFileSync(join(parent, 'README.md'), 'hi');
    const shop = repo('code', 'shop');
    await createProject(workspace, { name: 'Shop', folders: [shop] });

    const result = await listing(parent);
    expect(result).toMatchObject({ parent, total: 3, truncated: false });
    expect(result.folders.map((f) => [f.name, f.isGit, f.readable, f.project?.name ?? null, f.proposedName])).toEqual([
      ['notes', false, true, null, 'notes'],
      ['shop', true, true, 'Shop', null],
      ['web', true, true, null, 'web'],
    ]);
  });

  test('a symlink is resolved, and one whose real folder is a project counts as registered', async () => {
    const parent = folder('links');
    const real = repo('elsewhere', 'api');
    symlinkSync(real, join(parent, 'api-link'));
    const { id } = await createProject(workspace, { name: 'API', folders: [real] });
    const [linked] = (await listing(parent)).folders;
    expect(linked).toMatchObject({ name: 'api-link', path: real, isGit: true, project: { id, name: 'API' } });
  });

  test('a folder inside a git repository is marked, not offered', async () => {
    const parent = repo('mono');
    folder('mono', 'packages');
    const [inside] = (await listing(parent)).folders;
    expect(inside).toMatchObject({ name: 'packages', problem: `It is inside the git repository ${parent}. Add ${parent} itself instead.`, proposedName: null });
  });

  test('a linked worktree is marked with its main checkout, and with the project that has it', async () => {
    const main = repo('code', 'Bellbird');
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'first'], { cwd: main, stdio: 'ignore' });
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'side', join(root, 'code', 'Bellbird-metronome')], { cwd: main, stdio: 'ignore' });
    repo('code', 'Wren');
    const before = (await listing(join(root, 'code'))).folders;
    expect(before.map((f) => [f.name, f.isGit, f.worktreeOf])).toEqual([
      ['Bellbird', true, null],
      ['Bellbird-metronome', true, { path: main, name: 'Bellbird', project: null }],
      ['Wren', true, null],
    ]);
    // It can still be added; it is only not ticked for you.
    expect(before[1]!.proposedName).toBe('Bellbird-metronome');
    const made = await createProject(workspace, { name: 'Bellbird', folders: [main] });
    const after = (await listing(join(root, 'code'))).folders;
    expect(after[1]!.worktreeOf).toEqual({ path: main, name: 'Bellbird', project: { id: made.id, name: 'Bellbird' } });
  });

  test('names that would clash get the house suffix', async () => {
    const parent = folder('code');
    folder('code', 'web');
    await createProject(workspace, { name: 'web' });
    expect((await listing(parent)).folders[0]!.proposedName).toBe('web (code)');
  });

  test('cuts the list at the cap and says so', async () => {
    const parent = folder('many');
    const count = PROJECT_BATCH_LIMITS.maxListed + 3;
    for (let i = 0; i < count; i++) folder('many', `f${String(i).padStart(4, '0')}`);
    const result = await listing(parent);
    expect(result.folders).toHaveLength(PROJECT_BATCH_LIMITS.maxListed);
    expect(result).toMatchObject({ total: count, truncated: true });
    expect(result.folders[0]!.name).toBe('f0000');
  });

  test.skipIf(asRoot)('an unreadable folder is listed as one that cannot be added, and is refused as the folder to list', async () => {
    const parent = folder('code');
    repo('code', 'web');
    unreadable('code', 'secret');
    const result = await listing(parent);
    expect(result.folders.map((f) => [f.name, f.isGit, f.readable, f.proposedName])).toEqual([
      ['secret', false, false, null],
      ['web', true, true, 'web'],
    ]);
    const shut = unreadable('shut');
    await expect(listing(shut)).rejects.toThrow(new Refused(`Kestrel may not open ${shut}: permission denied.`));
  });

  test('refuses a missing path, a file and a relative path, with reasons', async () => {
    const missing = join(root, 'nope');
    await expect(listing(missing)).rejects.toThrow(new Refused(`${missing} is not a folder that exists.`));
    const file = join(folder('x'), 'file.txt');
    writeFileSync(file, '');
    await expect(listing(file)).rejects.toThrow(new Refused(`${file} is a file, not a folder.`));
    await expect(listing('code')).rejects.toThrow(/not a full path/);
  });
});

describe('creating several projects', () => {
  test('each is made through the same path as a single add, and the batch broadcasts once', async () => {
    const [web, notes] = [repo('code', 'web'), folder('code', 'notes')];
    let changes = 0;
    workspace.onChange(() => changes++);
    const outcomes = await createProjects(workspace, [web, notes]);
    expect(changes).toBe(1);
    expect(outcomes.map((o) => o.ok)).toEqual([true, true]);

    // A single add of the same kind of folder, for comparison.
    const single = await createProject(workspace, { name: 'single', folders: [repo('other', 'single')] });
    const made = (await projects()).find((p) => p.name === 'web')!;
    const shape = (p: typeof single) => ({ keys: Object.keys(p).sort(), folders: p.folders.map((f) => Object.keys(f).sort()), isDefault: p.defaultFolderId === p.folders[0]!.id });
    expect(shape(made)).toEqual(shape(single));
    expect(made.folders).toEqual([{ id: made.folders[0]!.id, path: web, isGit: true }]);
    expect((await projects()).find((p) => p.name === 'notes')!.folders[0]).toMatchObject({ path: notes, isGit: false });
  });

  test('names follow the unique-name rule, also between two folders of the same batch', async () => {
    const [a, b] = [folder('one', 'web'), folder('two', 'web')];
    const outcomes = await createProjects(workspace, [a, b]);
    expect(outcomes.map((o) => (o.ok ? o.project.name : o.error))).toEqual(['web', 'web (two)']);
  });

  test('a folder that fails says why and the rest are still added', async () => {
    const good = folder('code', 'good');
    const missing = join(root, 'code', 'gone');
    const inside = folder('code', 'repo', 'src');
    repo('code', 'repo');
    const outcomes = await createProjects(workspace, [missing, good, inside]);
    expect(outcomes).toEqual([
      { path: missing, ok: false, error: `${missing} is not a folder that exists.` },
      { path: good, ok: true, project: expect.objectContaining({ name: 'good' }) },
      { path: inside, ok: false, error: `${inside} is inside a git repository. Add its top level instead: ${join(root, 'code', 'repo')}` },
    ]);
    expect((await projects()).map((p) => p.name)).toEqual(['good']);
  });

  test.skipIf(asRoot)('a folder Kestrel may not open fails with that reason and the rest are still added', async () => {
    const good = folder('code', 'good');
    const shut = unreadable('code', 'shut');
    const outcomes = await createProjects(workspace, [shut, good]);
    expect(outcomes).toEqual([
      { path: shut, ok: false, error: `Kestrel may not open ${shut}: permission denied.` },
      { path: good, ok: true, project: expect.objectContaining({ name: 'good' }) },
    ]);
    expect((await projects()).map((p) => p.name)).toEqual(['good']);
  });

  test('an already registered folder is reported, not duplicated, also when listed twice', async () => {
    const [shop, web] = [folder('shop'), folder('web')];
    await createProject(workspace, { name: 'Shop', folders: [shop] });
    const outcomes = await createProjects(workspace, [shop, web, web]);
    expect(outcomes.map((o) => (o.ok ? `+${o.project.name}` : o.error))).toEqual([`${shop} is already in the project Shop.`, '+web', `${web} is already in the project web.`]);
    expect((await projects()).map((p) => p.name)).toEqual(['Shop', 'web']);
  });

  test('refuses an empty batch and one over the limit, with reasons', async () => {
    await expect(createProjects(workspace, [])).rejects.toThrow(new Refused('Choose at least one folder to add.'));
    const many = Array.from({ length: PROJECT_BATCH_LIMITS.maxPerBatch + 1 }, (_, i) => join(root, `f${i}`));
    await expect(createProjects(workspace, many)).rejects.toThrow(`At most ${PROJECT_BATCH_LIMITS.maxPerBatch} projects can be added at once; ${many.length} were chosen. Add them in smaller batches.`);
    expect(await projects()).toEqual([]);
  });
});

describe('the routes', () => {
  const TOKEN = 'test-token';
  const ORIGIN = 'http://localhost:5173';
  let app: KestrelServer;
  let base: string;

  beforeEach(async () => {
    const runtime = new SessionRuntime(workspace, {}, join(root, 'data'));
    const policy = { token: TOKEN, allowedOrigins: [ORIGIN], port: 0 };
    app = createKestrelServer(workspace, policy, runtime);
    await app.listen();
    policy.port = (app.server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${policy.port}`;
  });
  afterEach(() => app.close());

  const post = async (path: string, body: unknown, headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }) => {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  test('list a folder and create several from it', async () => {
    const parent = folder('code');
    const [web, notes] = [repo('code', 'web'), folder('code', 'notes')];
    const listed = await post('/api/projects/list-folder', { path: parent });
    expect(listed).toMatchObject({ status: 200, body: { parent, total: 2, folders: [{ name: 'notes' }, { name: 'web' }] } });
    const created = await post('/api/projects/create-many', { folders: [web, notes] });
    expect(created.status).toBe(200);
    expect(created.body.results.map((r: { ok: boolean; project?: { name: string } }) => r.project?.name)).toEqual(['web', 'notes']);
    expect((await post('/api/projects/list-folder', { path: parent })).body.folders.map((f: { project: { name: string } | null }) => f.project?.name)).toEqual(['notes', 'web']);
  });

  test('refusals are 409s with the reason, malformed bodies 400s', async () => {
    const missing = join(root, 'missing');
    expect(await post('/api/projects/list-folder', { path: missing })).toEqual({ status: 409, body: { error: `${missing} is not a folder that exists.` } });
    expect((await post('/api/projects/list-folder', {})).status).toBe(400);
    expect((await post('/api/projects/create-many', { folders: 'nope' })).status).toBe(400);
    expect((await post('/api/projects/create-many', { folders: [1] })).status).toBe(400);
    expect((await post('/api/projects/create-many', {})).status).toBe(400);
    const many = Array.from({ length: PROJECT_BATCH_LIMITS.maxPerBatch + 1 }, (_, i) => `/f${i}`);
    expect(await post('/api/projects/create-many', { folders: many })).toMatchObject({ status: 409, body: { error: expect.stringContaining('smaller batches') } });
  });

  test('both routes are behind the token, Origin and Host checks', async () => {
    const body = { path: folder('code') };
    for (const path of ['/api/projects/list-folder', '/api/projects/create-many']) {
      expect((await post(path, body, {})).status).toBe(401);
      expect((await post(path, body, { Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.example' })).status).toBe(403);
    }
    // fetch refuses to forge Host, so send the request by hand.
    const port = Number(new URL(base).port);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/api/projects/create-many', headers: { Authorization: `Bearer ${TOKEN}`, Host: `evil.example:${port}`, 'Content-Type': 'application/json' } }, (res) => (res.resume(), resolve(res.statusCode ?? 0)));
      req.on('error', reject);
      req.end(JSON.stringify({ folders: [body.path] }));
    });
    expect(status).toBe(403);
    expect(await projects()).toEqual([]);
  });
});
