// What was seen across the account (seen-sync.ts, account-seen.ts, seen.ts) against the fake service: each
// computer holds its own marks as one sealed record and reads the others'; two computers marking at once both
// win; a mark made offline is sent when the link comes back; marking unread travels; nothing of a project kept
// off is sent; a record from outside the keyring or under another computer's id is refused; a burst of marks is
// one write; and with no account nothing is read or written.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionView } from '../../model.ts';
import { SeenStore } from '../../seen.ts';
import { seenLabel, seenRecordOf, SEEN_LIST } from '../../shared/account-seen.ts';
import type { Machine } from '../../shared/machines.ts';
import { until } from '../../test-agent.ts';
import { sealRecord, tagOf } from '../account-key.ts';
import { newIdentity } from '../keys.ts';
import { AccountKeys, type KeysTrust } from './account-keys.ts';
import { FakeHeldService } from './connect-fakes.ts';
import { HeldApi } from './held-api.ts';
import { SeenSync } from './seen-sync.ts';

const LAPTOP: Machine = { id: 'laptop-1', name: 'MacBook Pro' };
const MINI: Machine = { id: 'mini-1', name: 'Mac mini' };
const STRANGER: Machine = { id: 'stranger-1', name: 'Somebody else' };

let closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closing) await close();
  closing = [];
  vi.useRealTimers();
});

async function account() {
  const service = new FakeHeldService();
  for (const m of [LAPTOP, MINI, STRANGER]) service.addDevice(m.id, m.name, 'desktop');
  const identity = newIdentity();
  let trust: KeysTrust | null = null;
  const keys = new AccountKeys({
    api: () => new HeldApi((m, p, b) => service.call(LAPTOP.id, m, p, b)),
    me: () => ({ id: LAPTOP.id, name: LAPTOP.name, identity }),
    trust: () => trust,
    saveTrust: async (next) => void (trust = next),
    changed: () => undefined,
  });
  await keys.sync();
  return { service, keys };
}

const session = (id: string, activity: number, project: string | null = 'p-shop'): SessionView => ({ id, updatedAt: activity, lastActivityAt: activity, startedIn: project, landedIn: null }) as unknown as SessionView;

/** A computer of the account: its own sessions, the ids of the other computer's, and a seen record with its sync. */
function computer(service: FakeHeldService, keys: AccountKeys, me: Machine, opts: { local: SessionView[]; remote?: SessionView[]; keptOff?: string[]; settleMs?: number }) {
  const settings = new Map<string, string>([['seen-marks', '{}']]);
  let clock = 1000;
  let online = true;
  const remote = opts.remote ?? [];
  const store = new SeenStore({
    settings: { getSetting: async (k) => settings.get(k) ?? null, putSetting: async (k, v) => void settings.set(k, v) },
    sessions: async () => [...opts.local, ...remote],
    now: () => clock,
  });
  const others = [LAPTOP, MINI].filter((m) => m.id !== me.id);
  const sync = new SeenSync({
    source: { store, sessions: async () => ({ local: opts.local, archived: [], remote: remote.map((s) => s.id) }) },
    api: () => (online ? new HeldApi((m, p, b) => service.call(me.id, m, p, b)) : null),
    key: () => keys.ready(),
    keyFor: (g) => keys.keyFor(g),
    desk: () => me,
    machines: () => others,
    keptOff: () => opts.keptOff ?? [],
    headsRead: () => true,
    settleMs: opts.settleMs ?? 60_000,
  });
  closing.push(() => sync.close());
  return { store, sync, settings, at: (t: number) => (clock = t), offline: (off: boolean) => (online = !off) };
}

const seenRecords = (service: FakeHeldService, keys: AccountKeys) => {
  const list = tagOf(keys.ready()!.idKey, SEEN_LIST);
  return [...service.records.values()].filter((r) => (r as { list?: string | null }).list === list);
};

describe('what was seen, across the account', () => {
  it('a session seen on one computer shows as seen on the other', async () => {
    const { service, keys } = await account();
    const s1 = session('s1', 50);
    const mini = computer(service, keys, MINI, { local: [s1] });
    const laptop = computer(service, keys, LAPTOP, { local: [], remote: [s1] });
    expect((await laptop.store.view()).s1).toBeUndefined();

    await mini.store.mark(['s1']);
    await mini.sync.run();
    await laptop.sync.run();

    expect(await laptop.store.view()).toEqual({ s1: 50 });
    // The laptop marked nothing: its record is empty.
    expect(await laptop.store.ownMarks()).toEqual({});
  });

  it('two computers marking different sessions at the same moment both win', async () => {
    const { service, keys } = await account();
    const sessions = [session('s1', 10), session('s2', 20)];
    const mini = computer(service, keys, MINI, { local: sessions });
    const laptop = computer(service, keys, LAPTOP, { local: [], remote: sessions });
    mini.at(5000);
    laptop.at(5000);
    await Promise.all([mini.store.mark(['s1']), laptop.store.mark(['s2'])]);
    await Promise.all([mini.sync.run(), laptop.sync.run()]);
    await Promise.all([mini.sync.run(), laptop.sync.run()]);

    expect(await mini.store.view()).toEqual({ s1: 10, s2: 20 });
    expect(await laptop.store.view()).toEqual({ s1: 10, s2: 20 });
    // One record each, nothing written over another's.
    expect(seenRecords(service, keys)).toHaveLength(2);
  });

  it('marking unread travels, and a later look anywhere wins over it', async () => {
    const { service, keys } = await account();
    const s1 = session('s1', 10);
    const mini = computer(service, keys, MINI, { local: [s1] });
    const laptop = computer(service, keys, LAPTOP, { local: [], remote: [s1] });
    await mini.store.mark(['s1']);
    await mini.sync.run();
    await laptop.sync.run();

    laptop.at(2000);
    await laptop.store.markUnread('s1');
    await laptop.sync.run();
    await mini.sync.run();
    expect((await mini.store.view()).s1).toBe(0);

    mini.at(3000);
    await mini.store.mark(['s1']);
    await mini.sync.run();
    await laptop.sync.run();
    expect((await laptop.store.view()).s1).toBe(10);
  });

  it('a mark made offline is sent when the link comes back', async () => {
    const { service, keys } = await account();
    const s1 = session('s1', 10);
    const mini = computer(service, keys, MINI, { local: [s1] });
    const laptop = computer(service, keys, LAPTOP, { local: [], remote: [s1] });
    laptop.offline(true);
    await laptop.store.mark(['s1']);
    await laptop.sync.run();
    expect(seenRecords(service, keys)).toHaveLength(0);

    laptop.offline(false);
    await laptop.sync.run();
    await mini.sync.run();
    expect(await mini.store.view()).toEqual({ s1: 10 });
  });

  it('a burst of marks is one write, after it settles', async () => {
    vi.useFakeTimers();
    const { service, keys } = await account();
    const sessions = [session('s1', 10), session('s2', 20), session('s3', 30)];
    const mini = computer(service, keys, MINI, { local: sessions, settleMs: 1000 });
    const puts = vi.spyOn(service, 'call');
    for (const id of ['s1', 's2', 's3']) await mini.store.mark([id]);
    const writes = () => puts.mock.calls.filter(([, method, path]) => method === 'PUT' && String(path).startsWith('/held/records/')).length;
    expect(writes()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    await mini.sync.settled();
    expect(writes()).toBe(1);
    vi.useRealTimers();
    await until(async () => seenRecords(service, keys).length === 1, 'the record is written');
  });

  it('sends nothing of a project kept off, nor of a session that is nowhere', async () => {
    const { service, keys } = await account();
    const sessions = [session('s1', 10), session('secret', 20, 'p-secret')];
    const laptop = computer(service, keys, LAPTOP, { local: [], remote: [session('s1', 10)] });
    const settings = new Map([['seen-marks', JSON.stringify({ gone: [1, 1] })]]);
    const fresh = new SeenStore({ settings: { getSetting: async (k) => settings.get(k) ?? null, putSetting: async (k, v) => void settings.set(k, v) }, sessions: async () => sessions, now: () => 1000 });
    const sync = new SeenSync({
      source: { store: fresh, sessions: async () => ({ local: sessions, archived: [], remote: [] }) },
      api: () => new HeldApi((m, p, b) => service.call(MINI.id, m, p, b)),
      key: () => keys.ready(),
      keyFor: (g) => keys.keyFor(g),
      desk: () => MINI,
      machines: () => [LAPTOP],
      keptOff: () => ['p-secret'],
      headsRead: () => true,
    });
    closing.push(() => sync.close());
    await fresh.mark(['s1', 'secret']);
    await sync.run();
    await laptop.sync.run();

    expect(await laptop.store.view()).toEqual({ s1: 10 });
    // Kept here, and the mark of a session that is nowhere is dropped.
    expect(await fresh.ownMarks()).toEqual({ s1: [10, 1000], secret: [20, 1000] });
    expect(JSON.stringify([...service.records.values()])).not.toContain('secret');
  });

  it('refuses a record from outside the keyring, and one under another computer’s id', async () => {
    const { service, keys } = await account();
    const laptop = computer(service, keys, LAPTOP, { local: [], remote: [session('s1', 10)] });
    const key = keys.ready()!;
    const tag = (label: string) => tagOf(key.idKey, label);
    const put = (writer: Machine, as: Machine) => {
      const id = tag(seenLabel(as.id));
      return service.call(writer.id, 'PUT', `/held/records/${encodeURIComponent(id)}`, { generation: key.generation, session: null, project: null, list: tag(SEEN_LIST), body: sealRecord(key.adk, 'record', id, key.generation, seenRecordOf(as, { s1: [10, 99] })) });
    };
    await put(STRANGER, STRANGER);
    await put(STRANGER, MINI);
    await laptop.sync.run();
    expect(await laptop.store.view()).toEqual({});
  });

  it('with no account, nothing is read or written', async () => {
    const service = new FakeHeldService();
    const store = new SeenStore({ settings: { getSetting: async () => '{}', putSetting: async () => undefined }, sessions: async () => [session('s1', 10)] });
    const calls = vi.spyOn(service, 'call');
    const sync = new SeenSync({ source: { store, sessions: async () => ({ local: [], archived: [], remote: [] }) }, api: () => null, key: () => null, keyFor: () => Buffer.alloc(32), desk: () => null, machines: () => [], keptOff: () => [], headsRead: () => true, settleMs: 0 });
    closing.push(() => sync.close());
    await store.mark(['s1']);
    await sync.run();
    expect(calls).not.toHaveBeenCalled();
    expect(await store.view()).toEqual({ s1: 10 });
  });
});
