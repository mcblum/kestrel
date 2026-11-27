// The view a window is sent (account-view.ts, Workspace.view): this computer's sessions with the other
// computers' beside them, filed as their own machine filed them, under this computer's project of the
// same repository; `state()` never holds them; and the HTTP routes read a remote session and refuse to
// act on it, naming its machine.
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { awayProjectId, withRemote } from './account-view.ts';
import { parseScope, scopeKey } from './shared/scope.ts';
import { createKestrelServer, type KestrelServer } from './http.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { sqlitePersistence } from './persistence/sqlite.ts';
import type { AccountProject } from './shared/account-projects.ts';
import type { AccountHead } from './shared/machines.ts';
import { Workspace } from './workspace.ts';

const MINI = { id: 'mini-1', name: 'Mac mini' };
const head = (id: string, over: Partial<AccountHead> = {}): AccountHead => ({ id, runsOn: MINI.id, title: id.toUpperCase(), agent: 'claude', state: 'done', note: '', project: { id: 'p-there', name: 'Shop' }, repos: ['example.test/acme/shop'], filing: 'started', branch: 'kestrel/x', request: null, createdAt: 1, updatedAt: 2, lastActivityAt: 2, messages: 2, chunks: 1, ...over });

describe.each([
  ['sqlite', () => sqlitePersistence(':memory:')],
  ['memory', () => memoryPersistence()],
])('the view a window is sent, on %s', (_name, makeDb) => {
  async function desk() {
    const ws = new Workspace(makeDb());
    await ws.addProject({ id: 'shop', name: 'Shop here', path: '/repos/shop', isGit: true });
    await ws.addSession({ id: 'own', title: 'Own', agent: 'claude', startedIn: 'shop' });
    const take = (heads: AccountHead[]) => ws.account.apply({ heads: heads.map((h) => ({ machine: MINI, head: h })), gone: [], members: [MINI.id], whole: true, mark: null });
    return { ws, take };
  }

  test('with no other computer it is the state itself', async () => {
    const { ws } = await desk();
    expect(await ws.view()).toBe(await ws.state());
  });

  test('another computer’s sessions are in the view with where they run, and never in the state', async () => {
    const { ws, take } = await desk();
    await take([head('r1', { state: 'running' })]);

    const view = await ws.view();
    expect(view.sessions.map((s) => [s.id, s.runsOn])).toEqual([['own', undefined], ['r1', MINI.id]]);
    expect(view.machines).toEqual([MINI]);
    expect(view.trees.ungrouped!.map((n) => n.sessionId)).toEqual(['own', 'r1']);
    expect((await ws.state()).sessions.map((s) => s.id)).toEqual(['own']);
    expect((await ws.state()).machines).toBeUndefined();
    // This computer's own session is the same object in both: an unchanged row is not redrawn.
    expect(view.sessions[0]).toBe((await ws.state()).sessions[0]);
  });

  test('the view is computed once per change, and again when the replica changes', async () => {
    const { ws, take } = await desk();
    await take([head('r1')]);
    const first = await ws.view();
    expect(await ws.view()).toBe(first);
    await take([head('r1'), head('r2')]);
    expect((await ws.view()).sessions.map((s) => s.id)).toEqual(['own', 'r1', 'r2']);
  });

  test('a remote session can be marked seen here', async () => {
    const { ws, take } = await desk();
    await take([head('r1')]);
    expect(Object.keys(await ws.seen.mark(['r1']))).toContain('r1');
  });
});

describe('putting remote sessions beside this computer’s own', () => {
  const state = async () => {
    const ws = new Workspace(memoryPersistence());
    await ws.addProject({ id: 'shop', name: 'Shop here', path: '/repos/shop', isGit: true });
    await ws.addProject({ id: 'docs', name: 'Docs', path: '/repos/docs', isGit: true });
    await ws.addSession({ id: 'own', title: 'Own', agent: 'claude', startedIn: 'shop' });
    return ws.state();
  };
  const keys = new Map([['shop', ['example.test/acme/shop']], ['docs', ['example.test/acme/docs']]]);

  test('a session is listed under this computer’s project of the same repository, filed as its machine filed it', async () => {
    const view = withRemote(await state(), [head('r1', { filing: 'landed' }), head('r2', { filing: 'pending' })], [MINI], keys);
    const [r1, r2] = view.sessions.slice(1);
    expect(r1).toMatchObject({ startedIn: 'shop', landedIn: 'shop', filing: { projectId: 'shop', status: 'landed' }, worktreePath: null, branch: 'kestrel/x' });
    expect(r2).toMatchObject({ startedIn: 'shop', landedIn: null, filing: { projectId: 'shop', status: 'pending' } });
    expect(view.projects.map((p) => p.id)).toEqual(['shop', 'docs']);
  });

  test('a project this computer does not have is listed once, with its sessions, and marked away', async () => {
    const elsewhere = { project: { id: 'p9', name: 'Billing' }, repos: ['example.test/acme/billing'] };
    const view = withRemote(await state(), [head('r1', elsewhere), head('r2', { ...elsewhere, runsOn: 'studio-1', project: { id: 'other-id', name: 'Billing' } })], [MINI, { id: 'studio-1', name: 'Studio' }], keys);
    const id = awayProjectId(head('r1', elsewhere));
    expect(view.projects.slice(2)).toEqual([{ id, name: 'Billing', folders: [], defaultFolderId: null, away: true, elsewhere: { machines: [{ ...MINI, projectId: 'p9' }, { id: 'studio-1', name: 'Studio', projectId: 'other-id' }], repos: ['example.test/acme/billing'], folders: [] } }]);
    expect(view.sessions.slice(1).map((s) => s.filing.projectId)).toEqual([id, id]);
    expect(view.machines?.map((m) => m.name)).toEqual(['Mac mini', 'Studio']);
  });

  test('a plain folder belongs to its machine, and a session with no project is unscoped', async () => {
    const view = withRemote(await state(), [head('r1', { repos: [], project: { id: 'p9', name: 'Notes' } }), head('r2', { repos: [], project: null, filing: 'unscoped' })], [MINI], keys);
    expect(view.projects.at(-1)).toMatchObject({ id: `machine|${MINI.id}|p9`, name: 'Notes', away: true });
    expect(view.sessions.at(-1)).toMatchObject({ startedIn: null, filing: { projectId: null, status: 'unscoped' } });
  });

  const record = (id: string, over: Partial<AccountProject> = {}): AccountProject => ({ id, machine: MINI, name: 'Billing', repos: ['example.test/acme/billing'], folders: [{ name: 'billing', isGit: true, path: '~/Code/billing' }], ...over });
  const STUDIO = { id: 'studio-1', name: 'Studio' };

  test('a project another computer has with no session is listed, and its sessions join it when they come', async () => {
    const before = await state();
    const alone = withRemote(before, [], [], keys, [record('p9')]);
    expect(alone.projects.slice(2)).toEqual([{ id: 'account|example.test/acme/billing', name: 'Billing', folders: [], defaultFolderId: null, away: true, elsewhere: { machines: [{ ...MINI, projectId: 'p9' }], repos: ['example.test/acme/billing'], folders: [{ name: 'billing', isGit: true, path: '~/Code/billing' }] } }]);
    // Nothing else changed: the sessions and their trees are this computer's own objects.
    expect(alone.sessions).toBe(before.sessions);
    expect(alone.trees).toBe(before.trees);
    const withSession = withRemote(before, [head('r1', { project: { id: 'p9', name: 'Billing' }, repos: ['example.test/acme/billing'] })], [MINI], keys, [record('p9')]);
    expect(withSession.projects).toHaveLength(3);
    expect(withSession.sessions.at(-1)?.filing.projectId).toBe('account|example.test/acme/billing');
  });

  test('one repository is one project: this computer’s own when it has it, else one for every computer that has it', async () => {
    const mine = withRemote(await state(), [], [], keys, [record('p-shop', { name: 'Shop there', repos: ['example.test/acme/shop'] })]);
    expect(mine.projects.map((p) => [p.id, p.name])).toEqual([['shop', 'Shop here'], ['docs', 'Docs']]);
    // Two computers' clones, one listing the repository second: still one project, naming both computers.
    const both = withRemote(await state(), [], [], keys, [record('p9'), record('q9', { machine: STUDIO, repos: ['example.test/acme/tools', 'example.test/acme/billing'] })]);
    expect(both.projects.slice(2).map((p) => [p.id, p.elsewhere?.machines.map((m) => m.name), p.elsewhere?.repos])).toEqual([['account|example.test/acme/billing', ['Mac mini', 'Studio'], ['example.test/acme/billing', 'example.test/acme/tools']]]);
  });

  test('a project of this computer that another computer has too says so, with its id there; one it alone has does not', async () => {
    const before = await state();
    const view = withRemote(before, [], [], keys, [record('p-shop', { name: 'Shop there', repos: ['example.test/acme/shop'] }), record('q-shop', { machine: STUDIO, repos: ['example.test/acme/shop'] })]);
    expect(view.projects[0]?.alsoOn).toEqual([{ ...MINI, projectId: 'p-shop' }, { ...STUDIO, projectId: 'q-shop' }]);
    // Docs is this computer's alone: the same object as before.
    expect(view.projects[1]).toBe(before.projects[1]);
  });

  test('a plain folder is listed as only its computer’s, one per computer, with its sessions', async () => {
    const plain = (machine: typeof MINI) => record('p-notes', { machine, name: 'Notes', repos: [], folders: [{ name: 'notes', isGit: false }] });
    const view = withRemote(await state(), [head('r1', { repos: [], project: { id: 'p-notes', name: 'Notes' } })], [MINI], keys, [plain(MINI), plain(STUDIO)]);
    expect(view.projects.slice(2).map((p) => [p.id, p.elsewhere?.machines.map((m) => m.name), p.elsewhere?.repos])).toEqual([
      [`machine|${MINI.id}|p-notes`, ['Mac mini'], []],
      [`machine|${STUDIO.id}|p-notes`, ['Studio'], []],
    ]);
    expect(view.sessions.at(-1)?.filing.projectId).toBe(`machine|${MINI.id}|p-notes`);
  });

  test('a project not here is known by an id its page’s panes can be keyed by', async () => {
    const view = withRemote(await state(), [], [], keys, [record('p9'), record('p-notes', { repos: [] })]);
    for (const p of view.projects.filter((x) => x.away)) expect(parseScope(scopeKey({ kind: 'project', id: p.id }))).toEqual({ kind: 'project', id: p.id });
  });

  test('a project this computer archived claims its repository: another computer’s record of it is not listed', async () => {
    const ws = new Workspace(memoryPersistence());
    await ws.addProject({ id: 'billing', name: 'Billing here', path: '/repos/billing', isGit: true });
    await ws.setArchived('project', 'billing', true);
    const view = withRemote(await ws.state(), [], [], new Map([['billing', ['example.test/acme/billing']]]), [record('p9')]);
    expect(view.projects.filter((p) => p.away)).toEqual([]);
  });

  test('a session its machine hid stays hidden, and one this computer has is its own', async () => {
    const view = withRemote(await state(), [head('r1', { filing: 'hidden' }), head('own', { title: 'Forged' })], [MINI], keys);
    expect(view.sessions.map((s) => [s.id, s.title, s.filing.status])).toEqual([['own', 'Own', 'started'], ['r1', 'R1', 'hidden']]);
  });
});

describe('a remote session over HTTP', () => {
  const TOKEN = 'test-token';
  let app: KestrelServer;
  afterEach(() => app.close());

  async function served() {
    const ws = new Workspace(memoryPersistence());
    await ws.addSession({ id: 'own', title: 'Own', agent: 'claude', startedIn: null });
    await ws.account.apply({ heads: [{ machine: MINI, head: head('r1') }], gone: [], members: [MINI.id], whole: true, mark: null });
    await ws.account.putChunks('r1', [{ n: 0, messages: [{ author: 'you', time: '', text: 'hello' }, { author: 'agent', time: '', text: 'hi' }] }], 1, 'stamp');
    const policy = { token: TOKEN, allowedOrigins: ['http://localhost:5173'], port: 0 };
    app = createKestrelServer(ws, policy);
    await app.listen();
    policy.port = (app.server.address() as AddressInfo).port;
    const call = (method: string, path: string, body?: unknown) => fetch(`http://127.0.0.1:${policy.port}${path}`, { method, headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { ws, call };
  }

  test('the state a window reads lists it, and its conversation is this computer’s kept copy', async () => {
    const { call } = await served();
    const state = await (await call('GET', '/api/state')).json();
    expect(state.sessions.map((s: { id: string }) => s.id)).toEqual(['own', 'r1']);
    const detail = await (await call('GET', '/api/sessions/r1')).json();
    expect(detail.session).toMatchObject({ id: 'r1', runsOn: MINI.id });
    expect(detail.messages.map((m: { text: string }) => m.text)).toEqual(['hello', 'hi']);
    expect(detail.remote).toEqual({ machine: MINI, current: false, reachable: false, asOf: null });
  });

  test.each([
    ['PATCH', '/api/sessions/r1', { title: 'x' }],
    ['DELETE', '/api/sessions/r1', undefined],
    ['POST', '/api/sessions/r1/reply', { text: 'x' }],
    ['POST', '/api/sessions/r1/stop', undefined],
    ['POST', '/api/sessions/r1/fork', {}],
    ['POST', '/api/sessions/r1/tags', { tag: 'x' }],
    ['GET', '/api/sessions/r1/files', undefined],
    ['GET', '/api/sessions/r1/git', undefined],
    ['POST', '/api/archive', { kind: 'session', id: 'r1' }],
  ])('%s %s is refused, saying where it runs', async (method, path, body) => {
    const { ws, call } = await served();
    const answer = await call(method, path, body);
    expect(answer.status).toBe(409);
    expect(await answer.json()).toEqual({ error: 'This session runs on Mac mini. That can only be done there.' });
    expect((await ws.view()).sessions.map((s) => s.title)).toEqual(['Own', 'R1']);
  });

  test('a project only another computer has is listed, and starting, renaming or archiving it here is refused with the reason', async () => {
    const { ws, call } = await served();
    await ws.accountProjects.apply({ projects: [{ record: 'rec-1', project: { id: 'p9', machine: MINI, name: 'Billing', repos: ['example.test/acme/billing'], folders: [] } }], gone: [], members: [MINI.id], whole: true, mark: null });
    const id = 'account|example.test/acme/billing';
    const state = await (await call('GET', '/api/state')).json();
    expect(state.projects.map((p: { id: string; away?: boolean }) => [p.id, p.away])).toContainEqual([id, true]);
    const start = await call('POST', '/api/sessions', { agent: 'claude', projectId: id, prompt: 'hello' });
    expect(start.status).toBe(409);
    expect((await start.json()).error).toMatch(/^Billing is not on this (Mac|computer)\. To run sessions here, clone acme\/billing on this (Mac|computer), or choose its folder if it is already here\.$/);
    const rename = await call('PATCH', `/api/projects/${encodeURIComponent(id)}`, { name: 'x' });
    expect(rename.status).toBe(409);
    expect((await rename.json()).error).toMatch(/^Billing is not on this (Mac|computer), so it can only be changed on Mac mini\.$/);
    expect((await call('POST', '/api/archive', { kind: 'project', id })).status).toBe(409);
    expect((await ws.view()).projects.map((p) => p.name)).toContain('Billing');
  });

  test('this computer’s own session is not touched by any of it', async () => {
    const { call } = await served();
    expect((await call('PATCH', '/api/sessions/own', { title: 'Renamed' })).status).toBe(204);
  });
});
