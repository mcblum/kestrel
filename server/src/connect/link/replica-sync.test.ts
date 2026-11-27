// The replica and its sync (account-replica.ts, replica-sync.ts) against the fake service: one computer
// (the Mac mini) holds its conversations as it does today, with the real runtime and a fake agent; the
// other (the laptop) reads them into its own database, on every provider behind the facade. The
// laptop's own sessions table never sees them, a head from a machine outside the keyring or under the
// wrong record is refused, a deleted session and a removed machine's rows go, and nothing is ever polled:
// a pass reads the change feed from where the last one stood.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '../../agents/types.ts';
import { SELECTABLE_AGENTS, type Agent } from '../../model.ts';
import { memoryPersistence } from '../../persistence/memory.ts';
import { sqlitePersistence } from '../../persistence/sqlite.ts';
import type { Persistence } from '../../persistence/types.ts';
import { createProject } from '../../project-store.ts';
import { SessionRuntime } from '../../runtime.ts';
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
import { PREFETCH_AT_ONCE, ReplicaSync } from './replica-sync.ts';

const LAPTOP = 'laptop-1';
const MINI = 'mini-1';
const MINI_MACHINE: Machine = { id: MINI, name: 'Mac mini' };

let closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closing) await close();
  closing = [];
  vi.useRealTimers();
});

/** One account key, opened by the laptop; the Mac mini seals with the same key (as joining gives it). */
async function account() {
  const service = new FakeHeldService();
  service.addDevice(LAPTOP, 'MacBook Pro', 'desktop');
  service.addDevice(MINI, 'Mac mini', 'desktop');
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

/** The Mac mini: a real workspace and runtime with a fake agent, holding its conversations. */
async function mini(service: FakeHeldService, keys: AccountKeys, prefs: () => HeldPrefs = () => DEFAULT_HELD_PREFS) {
  const workspace = new Workspace(memoryPersistence());
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-replica-')));
  const fakes = Object.fromEntries(SELECTABLE_AGENTS.map((a) => [a, new FakeAgents()])) as Record<Agent, FakeAgents>;
  const adapters = Object.fromEntries(SELECTABLE_AGENTS.map((a): [Agent, AgentAdapter] => [a, { ...fakes[a].adapter(), agent: a }]));
  const runtime = new SessionRuntime(workspace, adapters, data);
  const project = await createProject(workspace, { name: 'Shop' });
  for (const f of Object.values(fakes)) f.script = (turn) => turn.emit({ type: 'message', id: `a${turn.n}`, text: `answer ${turn.n}`, delta: `answer ${turn.n}`, done: true });
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      for (const f of Object.values(fakes)) await f.settled();
      for (const s of (await workspace.state()).sessions) await runtime.idle(s.id);
    }
  };
  const held = new HeldConversations({
    source: heldSource(workspace, runtime, connectLists(runtime.reviewPrefs, null, null)),
    api: () => new HeldApi((m, p, b) => service.call(MINI, m, p, b)),
    key: () => keys.ready(),
    keyFor: (g) => keys.keyFor(g),
    resync: () => keys.sync(),
    desk: () => MINI_MACHINE,
    prefs,
    queue: memoryQueueStore(),
    changed: () => undefined,
    here: 'your Mac',
    settleMs: 60_000,
    streamMs: 60_000,
  });
  closing.push(() => held.close());
  return { workspace, runtime, project, settle, held };
}

describe.each([
  ['sqlite', () => sqlitePersistence(':memory:')],
  ['memory', () => memoryPersistence()],
])('the replica on %s', (_name, makeDb) => {
  /** The laptop: its own database and workspace, and the sync that reads the others. */
  function laptop(service: FakeHeldService, keys: AccountKeys, opts: { online?: () => boolean; machines?: () => Machine[]; signedIn?: () => boolean; now?: () => number } = {}) {
    const db: Persistence = makeDb();
    const workspace = new Workspace(db);
    let changes = 0;
    workspace.onChange(() => changes++);
    const sync = new ReplicaSync({
      replica: workspace.account,
      api: () => (opts.online?.() ?? true ? new HeldApi((m, p, b) => service.call(LAPTOP, m, p, b)) : null),
      key: () => (opts.signedIn?.() ?? true ? keys.ready() : null),
      keyFor: (g) => keys.keyFor(g),
      desk: () => ({ id: LAPTOP }),
      machines: opts.machines ?? (() => [MINI_MACHINE]),
      now: opts.now,
    });
    closing.push(() => sync.close());
    return { db, workspace, sync, changes: () => changes };
  }

  it("holds the other computer's session heads, says so once, and not again while nothing changed", async () => {
    const { service, keys } = await account();
    const m = await mini(service, keys);
    const session = await m.runtime.start({ agent: 'claude', projectId: m.project.id, prompt: 'what is the total' });
    await m.settle();
    await m.held.run();
    const l = laptop(service, keys);

    await l.sync.run();

    const heads = await l.db.listAccountSessions();
    expect(heads).toMatchObject([{ id: session.id, runsOn: MINI, agent: 'claude', project: { id: m.project.id, name: 'Shop' }, messages: 2, chunks: 1 }]);
    expect(await l.workspace.account.machines()).toMatchObject([{ id: MINI, name: 'Mac mini' }]);
    expect(l.changes()).toBe(1);
    await l.sync.run();
    expect(l.changes()).toBe(1);
  });

  it('never puts a remote session among this computer’s own', async () => {
    const { service, keys } = await account();
    const m = await mini(service, keys);
    await m.runtime.start({ agent: 'codex', projectId: m.project.id, prompt: 'start' });
    await m.settle();
    await m.held.run();
    const l = laptop(service, keys);

    await l.sync.run();

    expect(await l.db.listSessions()).toEqual([]);
    expect(await l.db.markRunningInterrupted()).toBe(0);
    expect(await l.db.isEmpty()).toBe(true);
  });

  it('reads a conversation when it is opened, keeps it, and reads only what is new after another turn', async () => {
    const { service, keys } = await account();
    const m = await mini(service, keys);
    const session = await m.runtime.start({ agent: 'opencode', projectId: m.project.id, prompt: 'first' });
    await m.settle();
    await m.held.run();
    let online = true;
    const l = laptop(service, keys, { online: () => online });
    await l.sync.run();

    const first = await l.sync.conversation(session.id);
    expect(first?.current).toBe(true);
    expect(first?.messages.map((x) => x.text)).toEqual(['first', 'answer 1']);

    // Offline: what was kept is shown, and it is known to be whole.
    online = false;
    const kept = await l.sync.conversation(session.id);
    expect(kept?.messages.map((x) => x.text)).toEqual(['first', 'answer 1']);
    expect(kept?.current).toBe(true);

    // Another turn on the Mac mini: the head moves, and the stored copy is behind until the link is back.
    online = true;
    await m.runtime.reply(session.id, 'second');
    await m.settle();
    await m.held.run();
    await l.sync.run();
    online = false;
    expect((await l.sync.conversation(session.id))?.current).toBe(false);
    online = true;
    const after = await l.sync.conversation(session.id);
    expect(after?.current).toBe(true);
    expect(after?.messages.map((x) => x.text)).toEqual(['first', 'answer 1', 'second', 'answer 2']);
    expect((await l.db.listAccountDetails(session.id, 0, 10)).map((c) => c.n)).toEqual([0]);
  });

  it('reads every conversation that is behind its head in the background, a few at a time', async () => {
    const { service, keys } = await account();
    const m = await mini(service, keys);
    const sessions = [];
    for (let n = 0; n < 6; n++) {
      sessions.push(await m.runtime.start({ agent: SELECTABLE_AGENTS[n % 3]!, projectId: m.project.id, prompt: `task ${n}` }));
      await m.settle();
    }
    await m.held.run();
    let online = true;
    const l = laptop(service, keys, { online: () => online });
    // Counts the chunk reads under way at once, and which sessions' chunks are read first.
    let open = 0;
    let most = 0;
    const call = service.call.bind(service);
    service.call = async (device, method, path, body) => {
      const reading = device === LAPTOP && path === '/held/records/read' && (body as { ids: string[] }).ids.length > 0;
      if (reading) most = Math.max(most, ++open);
      try {
        if (reading) await new Promise((resolve) => setTimeout(resolve, 5));
        return await call(device, method, path, body);
      } finally {
        if (reading) open--;
      }
    };
    await l.sync.run();
    await l.sync.settled();
    expect(most).toBeLessThanOrEqual(PREFETCH_AT_ONCE);
    expect(most).toBeGreaterThan(0);

    // Opening any of them now is a local read: the service is not asked, and each is whole.
    online = false;
    for (const [n, s] of sessions.entries()) {
      const kept = await l.sync.conversation(s.id);
      expect(kept?.current).toBe(true);
      expect(kept?.messages.map((x) => x.text)).toEqual([`task ${n}`, 'answer 1']);
    }
    // Nothing that is current is read again.
    online = true;
    const marks = await l.workspace.account.detailMarks();
    expect(marks.size).toBe(6);
    const reads = service.calls.length;
    await l.sync.run();
    await l.sync.settled();
    expect(service.calls.slice(reads).some((c) => c.includes('/held/records/read'))).toBe(false);
  });

  it('answers nothing for a session it has no head of', async () => {
    const { service, keys } = await account();
    const l = laptop(service, keys);
    expect(await l.sync.conversation('nope')).toBeNull();
  });

  it('keeps a session the other computer archived as an archived head, restores it, and never receives a project kept off there (Matt, 2026-11-27)', async () => {
    const { service, keys } = await account();
    let prefs = DEFAULT_HELD_PREFS;
    const m = await mini(service, keys, () => prefs);
    const secret = await createProject(m.workspace, { name: 'Secret' });
    prefs = { ...DEFAULT_HELD_PREFS, keptOff: [secret.id] };
    const shown = await m.runtime.start({ agent: 'claude', projectId: m.project.id, prompt: 'shown' });
    await m.runtime.start({ agent: 'claude', projectId: secret.id, prompt: 'hidden' });
    await m.settle();
    await m.held.run();
    const l = laptop(service, keys);
    await l.sync.run();
    await l.sync.conversation(shown.id);
    expect((await l.db.listAccountSessions()).map((h) => h.id)).toEqual([shown.id]);

    const kept = await l.db.listAccountDetails(shown.id, 0, 10);
    expect(kept.length).toBeGreaterThan(0);
    await m.workspace.setArchived('session', shown.id, true);
    await m.held.run();
    await l.sync.run();

    // Only its head is held now, marked archived; its conversation went from the service, and the copy kept here stays.
    expect((await l.db.listAccountSessions()).map((h) => [h.id, h.archived, h.chunks])).toEqual([[shown.id, true, 0]]);
    expect(await l.db.listAccountDetails(shown.id, 0, 10)).toEqual(kept);
    expect((await l.db.listAccountRecords()).map((r) => r.key)).toEqual([`detail|${shown.id}`, 'feed|heads', `machine|${MINI}`]);

    // Restored there: listed again, its conversation held again.
    await m.workspace.setArchived('session', shown.id, false);
    await m.held.run();
    await l.sync.run();
    const [head] = await l.db.listAccountSessions();
    expect(head?.archived).toBeUndefined();
    expect(head?.chunks).toBeGreaterThan(0);

    // Deleted while archived: its head goes too.
    await m.workspace.setArchived('session', shown.id, true);
    await m.held.run();
    await m.runtime.deleteSession(shown.id);
    await m.held.run();
    await l.sync.run();
    expect(await l.db.listAccountSessions()).toEqual([]);
  });

  it('refuses a head from a machine outside the keyring, and one under a record that is not its session’s', async () => {
    const { service, keys } = await account();
    const key = keys.ready()!;
    const asMini = new HeldApi((m, p, b) => service.call(MINI, m, p, b));
    const session = (id: string) => ({ id, title: 'T', agent: 'claude', state: 'done', note: '', project: null, createdAt: 1, updatedAt: 1 });
    const putHead = (recordLabel: string, machine: Machine, sessionId: string) => {
      const id = tagOf(key.idKey, recordLabel);
      return asMini.putRecord(id, { generation: key.generation, session: null, project: null, list: tagOf(key.idKey, 'heads'), body: sealRecord(key.adk, 'record', id, key.generation, { v: 1, kind: 'head', machine, session: session(sessionId) }) });
    };
    await putHead('head|s1', { id: 'other-9', name: 'Somebody' }, 's1');
    await putHead('head|s2', MINI_MACHINE, 's3');
    await putHead('head|ok', MINI_MACHINE, 'ok');
    const l = laptop(service, keys);

    await l.sync.run();

    expect((await l.db.listAccountSessions()).map((h) => h.id)).toEqual(['ok']);
  });

  it('reads only what changed since the last pass, and learns of a deleted session from the feed', async () => {
    const { service, keys } = await account();
    const m = await mini(service, keys);
    const one = await m.runtime.start({ agent: 'claude', projectId: m.project.id, prompt: 'one' });
    const two = await m.runtime.start({ agent: 'claude', projectId: m.project.id, prompt: 'two' });
    await m.settle();
    await m.held.run();
    const l = laptop(service, keys);
    await l.sync.run();
    expect((await l.db.listAccountSessions()).map((h) => h.id).sort()).toEqual([one.id, two.id].sort());

    // Nothing changed: the feed is asked from where it stood, and no record is read (once the conversations
    // read in the background after the first pass are in).
    await l.sync.settled();
    service.calls.length = 0;
    await l.sync.run();
    expect(service.calls.filter((c) => c.includes('/held/changes'))).toEqual([expect.stringMatching(/since=[1-9]/)]);
    expect(service.calls.some((c) => c.includes('/held/records/read'))).toBe(false);

    await m.runtime.deleteSession(one.id);
    await m.held.run();
    await l.sync.run();
    expect((await l.db.listAccountSessions()).map((h) => h.id)).toEqual([two.id]);
  });

  it('is told by the service when a head changes, and reads every head again after a long time away', async () => {
    const { service, keys } = await account();
    const m = await mini(service, keys);
    const session = await m.runtime.start({ agent: 'claude', projectId: m.project.id, prompt: 'start' });
    await m.settle();
    service.notices.length = 0;
    await m.held.run();
    expect(service.notices.some((n) => n.message.service === 'changed' && n.to.includes(LAPTOP) && !n.to.includes(MINI))).toBe(true);

    let now = 1_000_000;
    const l = laptop(service, keys, { now: () => now });
    await l.sync.run();
    // The delete's place in the feed is long gone by the time the laptop is back: it reads the whole list.
    await m.runtime.deleteSession(session.id);
    await m.held.run();
    service.tombstones.clear();
    now += 26 * 24 * 60 * 60 * 1000;
    await l.sync.run();
    expect(await l.db.listAccountSessions()).toEqual([]);
  });

  it('reads only computers in the keyring, and drops the rows of one that was removed', async () => {
    const { service, keys } = await account();
    const m = await mini(service, keys);
    const session = await m.runtime.start({ agent: 'claude', projectId: m.project.id, prompt: 'start' });
    await m.settle();
    await m.held.run();
    let machines: Machine[] = [];
    const l = laptop(service, keys, { machines: () => machines });

    await l.sync.run();
    expect(await l.db.listAccountSessions()).toEqual([]);

    machines = [MINI_MACHINE];
    await l.sync.run();
    await l.sync.conversation(session.id);
    expect((await l.db.listAccountSessions()).length).toBe(1);

    machines = [];
    await l.sync.run();
    expect(await l.db.listAccountSessions()).toEqual([]);
    expect((await l.db.listAccountRecords()).map((r) => r.key)).toEqual(['feed|heads']);
    expect(await l.workspace.account.machines()).toEqual([]);
  });

  it('keeps nothing of the account after signing out', async () => {
    const { service, keys } = await account();
    const m = await mini(service, keys);
    await m.runtime.start({ agent: 'claude', projectId: m.project.id, prompt: 'start' });
    await m.settle();
    await m.held.run();
    const l = laptop(service, keys);
    await l.sync.run();

    await l.sync.forget();

    expect(await l.db.listAccountSessions()).toEqual([]);
    expect(await l.db.listAccountRecords()).toEqual([]);
  });

  it('against a service from before the change feed, still holds conversations for a phone and lists nothing', async () => {
    const { service, keys } = await account();
    service.beforeFeed = true;
    const m = await mini(service, keys);
    const session = await m.runtime.start({ agent: 'claude', projectId: m.project.id, prompt: 'start' });
    await m.settle();

    await m.held.run();

    const key = keys.ready()!;
    expect(service.records.has(tagOf(key.idKey, `index|${MINI}`))).toBe(true);
    expect(service.records.has(tagOf(key.idKey, `chunk|${MINI}|${session.id}|0`))).toBe(true);
    expect(service.records.has(tagOf(key.idKey, `head|${session.id}`))).toBe(false);
    expect(m.held.view().problem).toBeNull();
    const l = laptop(service, keys);
    await l.sync.run();
    expect(await l.db.listAccountSessions()).toEqual([]);
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
    expect(await l.db.listAccountSessions()).toEqual([]);
    expect(await l.db.listAccountRecords()).toEqual([]);
    expect(l.changes()).toBe(0);

    const signedIn = laptop(service, keys);
    await signedIn.sync.run();
    expect(vi.getTimerCount()).toBe(0);
  });
});
