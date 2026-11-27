// Projects across the account (project-sync.ts, account-projects.ts, account-view.ts) against the fake
// service, on every provider behind the facade: the Mac mini writes a sealed record per project it has, the
// laptop reads them into its replica and lists them beside its own, with or without sessions. A project kept
// off never arrives and leaves when switched off; a deleted project and a removed computer's projects go; a
// record from outside the keyring, under another project's id or from another writer is refused; and with no
// account nothing is read and no timer is set.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '../../agents/types.ts';
import { SELECTABLE_AGENTS, type Agent, type Project } from '../../model.ts';
import { memoryPersistence } from '../../persistence/memory.ts';
import { sqlitePersistence } from '../../persistence/sqlite.ts';
import { createProject } from '../../project-store.ts';
import { SessionRuntime } from '../../runtime.ts';
import { projectLabel } from '../../shared/account-projects.ts';
import type { Machine } from '../../shared/machines.ts';
import { FakeAgents } from '../../test-agent.ts';
import { Workspace } from '../../workspace.ts';
import { connectLists } from '../lists.ts';
import { sealRecord, tagOf } from '../account-key.ts';
import { newIdentity } from '../keys.ts';
import { AccountKeys, type KeysTrust } from './account-keys.ts';
import { FakeHeldService } from './connect-fakes.ts';
import { HeldApi } from './held-api.ts';
import { memoryQueueStore } from './held-queue.ts';
import { DEFAULT_HELD_PREFS, HeldConversations, heldSource, type HeldPrefs } from './held.ts';
import { ProjectSync, ProjectUploader } from './project-sync.ts';

const LAPTOP = 'laptop-1';
const MINI = 'mini-1';
const STRANGER = 'stranger-1';
const MINI_MACHINE: Machine = { id: MINI, name: 'Mac mini' };
const HOME = '/Users/someone';

let closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closing) await close();
  closing = [];
  vi.useRealTimers();
});

async function account() {
  const service = new FakeHeldService();
  service.addDevice(LAPTOP, 'MacBook Pro', 'desktop');
  service.addDevice(MINI, 'Mac mini', 'desktop');
  service.addDevice(STRANGER, 'Somebody else', 'desktop');
  const identity = newIdentity();
  let trust: KeysTrust | null = null;
  const keys = new AccountKeys({
    api: () => new HeldApi((m, p, b) => service.call(LAPTOP, m, p, b)),
    me: () => ({ id: LAPTOP, name: 'MacBook Pro', identity }),
    trust: () => trust,
    saveTrust: async (next) => void (trust = next),
    changed: () => undefined,
  });
  await keys.sync();
  return { service, keys };
}

/** A computer writing its projects as the held pass does: its projects, the ones kept off, its repository keys. */
function writer(service: FakeHeldService, keys: AccountKeys, machine: Machine) {
  const uploader = new ProjectUploader(HOME);
  return (projects: Project[], opts: { keptOff?: string[]; repos?: Record<string, string[]> } = {}) =>
    uploader.pass({ api: new HeldApi((m, p, b) => service.call(machine.id, m, p, b)), key: keys.ready()!, desk: machine, projects, keptOff: opts.keptOff ?? [], repos: async (id) => opts.repos?.[id] ?? [] });
}

const project = (id: string, name: string, folders: Project['folders'] = []): Project => ({ id, name, folders, defaultFolderId: null });

describe.each([
  ['sqlite', () => sqlitePersistence(':memory:')],
  ['memory', () => memoryPersistence()],
])('projects across the account on %s', (_name, makeDb) => {
  function laptop(service: FakeHeldService, keys: AccountKeys, opts: { machines?: () => Machine[]; signedIn?: () => boolean } = {}) {
    const db = makeDb();
    const workspace = new Workspace(db);
    let changes = 0;
    workspace.onChange(() => changes++);
    const sync = new ProjectSync({
      store: workspace.accountProjects,
      api: () => new HeldApi((m, p, b) => service.call(LAPTOP, m, p, b)),
      key: () => ((opts.signedIn?.() ?? true) ? keys.ready() : null),
      keyFor: (g) => keys.keyFor(g),
      desk: () => ({ id: LAPTOP }),
      machines: opts.machines ?? (() => [MINI_MACHINE]),
    });
    closing.push(() => sync.close());
    const away = async () => (await workspace.view()).projects.filter((p) => p.away);
    return { db, workspace, sync, away, changes: () => changes };
  }

  it('lists a project with no sessions that only the other computer has, with its folders as it told of them', async () => {
    const { service, keys } = await account();
    await writer(service, keys, MINI_MACHINE)([project('p-shop', 'Shop', [{ id: 'f1', path: `${HOME}/Code/shop`, isGit: true }, { id: 'f2', path: '/opt/data', isGit: false }])], { repos: { 'p-shop': ['example.test/acme/shop'] } });
    const l = laptop(service, keys);

    await l.sync.run();

    expect(await l.away()).toEqual([
      { id: 'account|example.test/acme/shop', name: 'Shop', folders: [], defaultFolderId: null, away: true, elsewhere: { machines: [{ ...MINI_MACHINE, projectId: 'p-shop' }], repos: ['example.test/acme/shop'], folders: [{ name: 'shop', isGit: true, path: '~/Code/shop' }, { name: 'data', isGit: false }] } },
    ]);
    // Never this computer's own: nothing that runs or files sees it.
    expect((await l.workspace.state()).projects).toEqual([]);
    expect(await l.db.listProjects()).toEqual([]);
    // Never a path outside the home folder, sealed or not.
    expect(JSON.stringify([...service.records.values()])).not.toContain('/opt/data');
    expect(l.changes()).toBe(1);
    await l.sync.run();
    expect(l.changes()).toBe(1);
  });

  it('lists a plain folder as only on its computer', async () => {
    const { service, keys } = await account();
    await writer(service, keys, MINI_MACHINE)([project('p-notes', 'Notes', [{ id: 'f1', path: `${HOME}/notes`, isGit: false }])]);
    const l = laptop(service, keys);
    await l.sync.run();
    expect(await l.away()).toMatchObject([{ id: `machine|${MINI}|p-notes`, name: 'Notes', elsewhere: { machines: [MINI_MACHINE], repos: [] } }]);
  });

  it('never receives a project kept off, and deletes one when it is switched off', async () => {
    const { service, keys } = await account();
    const write = writer(service, keys, MINI_MACHINE);
    const projects = [project('p-shop', 'Shop'), project('p-secret', 'Secret')];
    await write(projects, { keptOff: ['p-secret'] });
    const l = laptop(service, keys);
    await l.sync.run();
    expect((await l.away()).map((p) => p.name)).toEqual(['Shop']);

    await write(projects, { keptOff: ['p-secret', 'p-shop'] });
    await l.sync.run();
    expect(await l.away()).toEqual([]);

    await write(projects, { keptOff: [] });
    await l.sync.run();
    expect((await l.away()).map((p) => p.name).sort()).toEqual(['Secret', 'Shop']);
  });

  it('drops a deleted project, and takes a rename', async () => {
    const { service, keys } = await account();
    const write = writer(service, keys, MINI_MACHINE);
    await write([project('p-shop', 'Shop'), project('p-old', 'Old')]);
    const l = laptop(service, keys);
    await l.sync.run();

    await write([project('p-shop', 'Shop front')]);
    await l.sync.run();

    expect((await l.away()).map((p) => p.name)).toEqual(['Shop front']);
  });

  it('deletes on the next run what it wrote of a project it no longer has', async () => {
    const { service, keys } = await account();
    await writer(service, keys, MINI_MACHINE)([project('p-shop', 'Shop'), project('p-gone', 'Gone')]);
    // A new run (Kestrel restarted) with one project deleted meanwhile.
    await writer(service, keys, MINI_MACHINE)([project('p-shop', 'Shop')]);
    const l = laptop(service, keys);
    await l.sync.run();
    expect((await l.away()).map((p) => p.name)).toEqual(['Shop']);
  });

  it('drops the projects of a computer removed from the account', async () => {
    const { service, keys } = await account();
    await writer(service, keys, MINI_MACHINE)([project('p-shop', 'Shop')]);
    let machines = [MINI_MACHINE];
    const l = laptop(service, keys, { machines: () => machines });
    await l.sync.run();
    expect(await l.away()).toHaveLength(1);

    machines = [];
    await l.sync.run();

    expect(await l.away()).toEqual([]);
    expect((await l.db.listAccountRecords()).filter((r) => r.key.startsWith('aproject|'))).toEqual([]);
  });

  it('refuses a record from outside the keyring, under another project’s id, or naming another writer', async () => {
    const { service, keys } = await account();
    await writer(service, keys, { id: STRANGER, name: 'Somebody else' })([project('p-x', 'Theirs')]);
    const key = keys.ready()!;
    const put = (as: string, id: string, body: unknown) => service.call(as, 'PUT', `/held/records/${encodeURIComponent(id)}`, { generation: key.generation, session: null, project: null, list: tagOf(key.idKey, 'projects'), body: sealRecord(key.adk, 'record', id, key.generation, body) });
    const misfiled = tagOf(key.idKey, projectLabel('p-other'));
    await put(MINI, misfiled, { v: 1, kind: 'project', machine: MINI_MACHINE, project: { id: 'p-real', name: 'Misfiled', repos: [], folders: [] } });
    const forged = tagOf(key.idKey, projectLabel('p-forged'));
    await put(STRANGER, forged, { v: 1, kind: 'project', machine: MINI_MACHINE, project: { id: 'p-forged', name: 'Forged', repos: [], folders: [] } });
    const l = laptop(service, keys);

    await l.sync.run();

    expect(await l.away()).toEqual([]);
  });

  it('keeps nothing of the account after signing out', async () => {
    const { service, keys } = await account();
    await writer(service, keys, MINI_MACHINE)([project('p-shop', 'Shop')]);
    const l = laptop(service, keys);
    await l.sync.run();
    await l.sync.forget();
    expect(await l.db.listAccountRecords()).toEqual([]);
    expect(await l.away()).toEqual([]);
  });

  it('against a service from before the change feed writes nothing and stops asking', async () => {
    const { service, keys } = await account();
    service.beforeFeed = true;
    const write = writer(service, keys, MINI_MACHINE);
    const calls = vi.spyOn(service, 'call');
    await write([project('p-shop', 'Shop')]);
    await write([project('p-shop', 'Shop')]);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(service.records.size).toBe(0);
  });

  it('with no account reads nothing and stores nothing, and with one sets no timer', async () => {
    vi.useFakeTimers();
    const { service, keys } = await account();
    const calls = vi.spyOn(service, 'call');
    const l = laptop(service, keys, { signedIn: () => false });
    calls.mockClear();

    l.sync.kick();
    await l.sync.run();

    expect(calls).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(await l.db.listAccountRecords()).toEqual([]);
    expect(l.changes()).toBe(0);
    const signedIn = laptop(service, keys);
    await signedIn.sync.run();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is written by the held pass: a project with no session crosses over, a kept-off one never does', async () => {
    const { service, keys } = await account();
    let prefs: HeldPrefs = DEFAULT_HELD_PREFS;
    const workspace = new Workspace(memoryPersistence());
    const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-projects-')));
    const adapters = Object.fromEntries(SELECTABLE_AGENTS.map((a): [Agent, AgentAdapter] => [a, { ...new FakeAgents().adapter(), agent: a }]));
    const runtime = new SessionRuntime(workspace, adapters, data);
    await createProject(workspace, { name: 'Empty' });
    const secret = await createProject(workspace, { name: 'Secret' });
    prefs = { ...DEFAULT_HELD_PREFS, keptOff: [secret.id] };
    const held = new HeldConversations({
      source: heldSource(workspace, runtime, connectLists(runtime.reviewPrefs, null, null)),
      api: () => new HeldApi((m, p, b) => service.call(MINI, m, p, b)),
      key: () => keys.ready(),
      keyFor: (g) => keys.keyFor(g),
      resync: () => keys.sync(),
      desk: () => MINI_MACHINE,
      prefs: () => prefs,
      queue: memoryQueueStore(),
      changed: () => undefined,
      here: 'your Mac',
      settleMs: 60_000,
      streamMs: 60_000,
      projects: new ProjectUploader(HOME),
    });
    closing.push(() => held.close());
    await held.run();
    const l = laptop(service, keys);
    await l.sync.run();
    expect((await l.away()).map((p) => p.name)).toEqual(['Empty']);

    // Switched off where it was kept off: on the service, sealed, with the rest.
    const before = prefs;
    prefs = DEFAULT_HELD_PREFS;
    await held.prefsChanged(before, prefs);
    await held.run();
    await l.sync.run();
    expect((await l.away()).map((p) => p.name).sort()).toEqual(['Empty', 'Secret']);
  });
});
