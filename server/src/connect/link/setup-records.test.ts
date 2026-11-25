// Set-up records on the service (setup-records.ts): each computer writes its own sealed record under
// `tag("setup|<id>")` through the held-record routes, rewrites it only when it changed, and reads the
// others' records back; the service sees ciphertext only. With no account nothing reads the machine
// and nothing reaches the service.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { memorySettings } from '../../suggestions/prefs.ts';
import { setupListOf } from '../../shared/setup-list.ts';
import { setupLabel, SETUP_RECORD_VERSION, type SetupRecord } from '../../shared/setup-record.ts';
import { tagOf } from '../account-key.ts';
import { newIdentity } from '../keys.ts';
import { connectRoute } from './api.ts';
import { AccountKeys, type KeysTrust } from './account-keys.ts';
import { FakeHeldService, FakeIdentity, FakeService, fakeListener, tokensFor } from './connect-fakes.ts';
import { CONNECT_PREFS_KEY, KestrelConnect } from './connect.ts';
import { HeldApi } from './held-api.ts';
import { SetupRecords } from './setup-records.ts';
import { memoryVault } from './vault.ts';

afterEach(() => vi.useRealTimers());

const LAPTOP = 'laptop-1';
const MINI = 'mini-1';

function recordOf(id: string, name: string, extra: Partial<SetupRecord> = {}): SetupRecord {
  return {
    v: SETUP_RECORD_VERSION,
    kind: 'setup',
    machine: { id, name, platform: 'mac' },
    readAt: 1,
    agents: [],
    hosts: [],
    git: { name: null, email: null, signs: false, format: null, signingKey: null },
    ssh: { hosts: [], keyFiles: [] },
    mcp: [],
    files: [],
    tools: [],
    projects: [],
    problems: [],
    ...extra,
  };
}

/** One account key, opened by the laptop; the Mac mini is given the same key (as joining does). */
async function account() {
  const service = new FakeHeldService();
  service.addDevice(LAPTOP, 'MacBook Pro', 'desktop');
  service.addDevice(MINI, 'Mac mini', 'desktop');
  service.addDevice('phone-1', 'iPhone', 'phone');
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
  const records = (id: string, name: string, read: () => SetupRecord) =>
    new SetupRecords({ api: () => new HeldApi((m, p, b) => service.call(id, m, p, b)), key: () => keys.ready(), keyFor: (g) => keys.keyFor(g), desk: () => ({ id, name }), inventory: async () => read() });
  return { service, keys, records };
}

describe('set-up records', () => {
  it('are written sealed under the machine tag and read back by the other machine', async () => {
    const { service, keys, records } = await account();
    let laptop = recordOf(LAPTOP, 'MacBook Pro', { agents: [{ agent: 'codex', state: 'ready' }], mcp: [{ name: 'home-assistant', scope: 'user', transport: 'stdio', command: 'uvx', args: ['mcp-ha'], url: null, env: ['HOMEASSISTANT_TOKEN'], headers: [], blanks: [{ kind: 'env', name: 'HOMEASSISTANT_TOKEN' }], appProgram: null }] });
    const onLaptop = records(LAPTOP, 'MacBook Pro', () => laptop);
    await onLaptop.write();
    const id = tagOf(keys.ready()!.idKey, setupLabel(LAPTOP));
    const stored = service.records.get(id)!;
    expect(stored).toMatchObject({ session: null, project: null });
    // Sealed: the service sees neither the server's name nor the secret's.
    expect(stored.body).not.toContain('home-assistant');
    expect(stored.body).not.toContain('HOMEASSISTANT');

    const onMini = records(MINI, 'Mac mini', () => recordOf(MINI, 'Mac mini', { agents: [{ agent: 'codex', state: 'signed-out' }] }));
    const devices = await new HeldApi((m, p, b) => service.call(MINI, m, p, b)).devices();
    const { here, others } = await onMini.read(devices);
    expect(here.machine.name).toBe('Mac mini');
    expect(others.map((o) => o.machine.name)).toEqual(['MacBook Pro']);

    const list = setupListOf(here, others, { tool: () => false });
    expect(list.lines.find((l) => l.id === 'agent:codex')).toMatchObject({ kind: 'here', done: false, action: { kind: 'sign-in', agent: 'codex' }, from: ['MacBook Pro'] });
    expect(list.lines.find((l) => l.id === 'mcp:home-assistant')).toMatchObject({ kind: 'bring', secrets: ['HOMEASSISTANT_TOKEN'], done: false });

    // Unchanged: not written again. Changed: written again.
    const puts = () => service.calls.filter((c) => c.startsWith('PUT /held/records/')).length;
    const before = puts();
    await onLaptop.write();
    expect(puts()).toBe(before);
    laptop = { ...laptop, readAt: 99 };
    await onLaptop.write();
    expect(puts()).toBe(before);
    laptop = { ...laptop, agents: [] };
    await onLaptop.write();
    expect(puts()).toBe(before + 1);
  });

  it('ignores a record that claims to be another machine', async () => {
    const { records } = await account();
    await records(LAPTOP, 'MacBook Pro', () => recordOf('someone-else', 'Imposter')).write();
    const { others } = await records(MINI, 'Mac mini', () => recordOf(MINI, 'Mac mini')).read([
      { id: LAPTOP, name: 'MacBook Pro', kind: 'desktop' },
      { id: MINI, name: 'Mac mini', kind: 'desktop' },
    ]);
    expect(others).toEqual([]);
  });

  it('refuses with the reason while there is no service or key', async () => {
    const inventory = vi.fn(async () => recordOf(LAPTOP, 'x'));
    const records = new SetupRecords({ api: () => null, key: () => null, keyFor: () => Buffer.alloc(32), desk: () => null, inventory });
    await expect(records.write()).rejects.toThrow(/Kestrel Connect on, signed in/);
    records.refresh();
    expect(inventory).not.toHaveBeenCalled();
  });
});

describe('with no account', () => {
  it('never reads the machine and calls nothing', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-24T12:00:00Z') });
    const service = new FakeService();
    const settings = memorySettings();
    await settings.putSetting(CONNECT_PREFS_KEY, JSON.stringify({ enabled: true }));
    const inventory = vi.fn(async () => recordOf(LAPTOP, 'x'));
    const tool = vi.fn(() => true);
    const connect = new KestrelConnect({ vault: memoryVault(), identity: new FakeIdentity(), service, settings, computerName: 'Desk', listen: fakeListener().listen, setup: { inventory, checks: { tool } } });
    await connect.start();
    connect.setupRefresh();
    const answer = await connectRoute(['api', 'connect', 'setup'], 'GET', async () => ({}), connect);
    expect(answer?.status).toBe(409);
    expect(await connectRoute(['api', 'connect', 'setup', 'record'], 'POST', async () => ({}), connect)).toEqual({ status: 204 });
    await vi.runOnlyPendingTimersAsync();
    expect(inventory).not.toHaveBeenCalled();
    expect(tool).not.toHaveBeenCalled();
    expect(service.sockets).toHaveLength(0);
    expect(service.seen).toEqual([]);
    expect(service.held.calls).toEqual([]);
    await connect.close();
  });

  it('signed in but not connected, still reads nothing', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-24T12:00:00Z') });
    const service = new FakeService();
    const inventory = vi.fn(async () => recordOf(LAPTOP, 'x'));
    const connect = new KestrelConnect({ vault: memoryVault({ tokens: tokensFor(0, Date.now()), device: null }), identity: new FakeIdentity(), service, settings: memorySettings(), computerName: 'Desk', listen: fakeListener().listen, setup: { inventory, checks: { tool: () => true } } });
    await connect.start();
    connect.setupRefresh();
    await expect(connect.setupList()).rejects.toThrow(/connected/);
    expect(inventory).not.toHaveBeenCalled();
    expect(service.sockets).toHaveLength(0);
    await connect.close();
  });
});
