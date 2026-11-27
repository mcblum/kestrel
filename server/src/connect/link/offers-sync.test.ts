// What each computer offers for a new session (offers-sync.ts, remote-starts/offers.ts, shared/machine-offers.ts),
// against the fake service with the real runtime and workspace: the record is the live `session.startChoices`
// answer; it is written when the link comes up and when each change source fires, and not otherwise; two
// computers each read the other's; a project kept off is not in it; and nothing secret is ever in its plaintext.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, ModelOption } from '../../agents/types.ts';
import { SELECTABLE_AGENTS, type Agent } from '../../model.ts';
import { memoryPersistence } from '../../persistence/memory.ts';
import { createProject } from '../../project-store.ts';
import { offersSource, offersWatch } from '../../remote-starts/offers.ts';
import { SessionRuntime } from '../../runtime.ts';
import { CONNECT_PROTOCOL_VERSION } from '../../shared/connect-ops.ts';
import { asOffersRecord, HIDDEN, MAX_OFFERS_BODY, OFFERS_LIST, offersLabel, offersRecordOf, type RemoteStartChoices } from '../../shared/machine-offers.ts';
import type { Machine } from '../../shared/machines.ts';
import { FakeAgents, until } from '../../test-agent.ts';
import { Workspace } from '../../workspace.ts';
import { openRecord, sealRecord, tagOf } from '../account-key.ts';
import { ConnectDispatcher } from '../dispatcher.ts';
import { newIdentity } from '../keys.ts';
import { AccountKeys, type KeysTrust } from './account-keys.ts';
import { FakeHeldService } from './connect-fakes.ts';
import { HeldApi } from './held-api.ts';
import { OffersSync } from './offers-sync.ts';

const LAPTOP: Machine = { id: 'laptop-1', name: 'MacBook Pro' };
const MINI: Machine = { id: 'mini-1', name: 'Mac mini' };
const SETTLE = 5;

let closing: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closing) await close();
  closing = [];
  vi.restoreAllMocks();
});

async function account() {
  const service = new FakeHeldService();
  for (const m of [LAPTOP, MINI]) service.addDevice(m.id, m.name, 'desktop');
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

const MODELS: ModelOption[] = [
  { id: '', label: 'Default' },
  { id: 'wren-3', label: 'Wren 3', efforts: ['low', 'high'] },
];

interface AgentState {
  available: boolean;
  reason?: string;
  models: ModelOption[];
}

/** A computer of the account: the real workspace and runtime, fake agents whose answers a test changes, and its offers sync. */
async function computer(service: FakeHeldService, keys: AccountKeys, me: Machine, opts: { home?: string; user?: string; keptOff?: string[] } = {}) {
  const workspace = new Workspace(memoryPersistence());
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-offers-')));
  const agents = Object.fromEntries(SELECTABLE_AGENTS.map((a) => [a, { available: true, models: MODELS } as AgentState])) as Record<Agent, AgentState>;
  const adapters = Object.fromEntries(
    SELECTABLE_AGENTS.map((a): [Agent, AgentAdapter] => {
      const base = new FakeAgents().adapter();
      return [a, { ...base, agent: a, availability: async () => ({ available: agents[a].available, ...(agents[a].reason ? { reason: agents[a].reason } : {}) }), models: async () => ({ models: agents[a].models, fromSdk: true }) }];
    }),
  );
  const runtime = new SessionRuntime(workspace, adapters, data);
  let keptOff = opts.keptOff ?? [];
  /** What this computer asked the service, as `METHOD /path`. */
  const calls: string[] = [];
  let failReads = 0;
  const keptOffListeners = new Set<() => void>();
  const watch = offersWatch(runtime, workspace);
  const sync = new OffersSync({
    source: offersSource(runtime, workspace, 'your Mac', opts.home, opts.user),
    store: workspace.accountOffers,
    watch: (changed) => {
      const off = watch(changed);
      const k = () => changed(false);
      keptOffListeners.add(k);
      return () => {
        off();
        keptOffListeners.delete(k);
      };
    },
    api: () =>
      new HeldApi(async (m, p, b) => {
        calls.push(`${m} ${p.split('?')[0]}`);
        if (p.startsWith('/held/changes') && failReads > 0) {
          failReads--;
          throw new Error('The network went away.');
        }
        return service.call(me.id, m, p, b);
      }),
    key: () => keys.ready(),
    keyFor: (g) => keys.keyFor(g),
    desk: () => me,
    machines: () => [LAPTOP, MINI],
    keptOff: () => keptOff,
    settleMs: SETTLE,
  });
  const dispatcher = new ConnectDispatcher({ workspace, runtime, deviceId: me.id, here: 'your Mac', send: () => undefined, keptOff: () => keptOff });
  closing.push(() => sync.close(), () => dispatcher.close());
  let n = 0;
  /** What a phone is answered live. */
  const live = async () => {
    const answer = (await dispatcher.receive({ v: CONNECT_PROTOCOL_VERSION, from: 'phone-1', to: me.id, kind: 'request', id: `q${++n}`, body: { op: 'session.startChoices', args: {} } })) as { body: { ok: boolean; result: unknown } };
    expect(answer.body.ok).toBe(true);
    return answer.body.result;
  };
  /** This computer's record as the service holds it, opened. */
  const record = () => {
    const key = keys.ready()!;
    const id = tagOf(key.idKey, offersLabel(me.id));
    const held = service.records.get(id);
    if (!held) return null;
    expect(held.list).toBe(tagOf(key.idKey, OFFERS_LIST));
    expect(held.writer).toBe(me.id);
    return openRecord(keys.keyFor(held.generation), held.body, 'record', id, held.generation) as Record<string, unknown>;
  };
  /** Lets a burst settle and the pass it scheduled run. */
  const settle = async () => {
    await new Promise((r) => setTimeout(r, SETTLE * 4));
    await sync.settled();
  };
  const setKeptOff = (ids: string[]) => {
    keptOff = ids;
    for (const l of keptOffListeners) l();
  };
  return { workspace, runtime, agents, sync, live, record, settle, setKeptOff, calls, failNextRead: () => void (failReads = 1) };
}

describe('what a computer offers, held on Kestrel Connect', () => {
  it('the record is the live answer, with the computer and when it was made', async () => {
    const { service, keys } = await account();
    const mini = await computer(service, keys, MINI);
    await createProject(mini.workspace, { name: 'Shop' });
    await mini.runtime.whoDoesWhat.set({ ...(await mini.runtime.whoDoesWhat.current()), presets: [{ name: 'Quick', agent: 'claude', model: 'wren-3', effort: 'low', fast: false }] });
    mini.sync.connected();
    await mini.sync.settled();

    const record = mini.record()!;
    expect(record).toMatchObject({ v: 1, kind: 'offers', machine: MINI });
    expect(typeof record.made).toBe('number');
    expect(record.offers).toEqual(await mini.live());
    expect((record.offers as { projects: { name: string }[] }).projects.map((p) => p.name)).toEqual(['Shop']);
    expect(asOffersRecord(record)).not.toBeNull();
  });

  it('is written again when each change source fires, and not otherwise', async () => {
    const { service, keys } = await account();
    const mini = await computer(service, keys, MINI);
    const project = await createProject(mini.workspace, { name: 'Shop' });
    mini.sync.connected();
    await mini.sync.settled();
    expect(mini.sync.writes).toBe(1);
    const step = async (what: string, change: () => Promise<unknown> | unknown, writes: number) => {
      await change();
      await mini.settle();
      expect(mini.sync.writes, what).toBe(writes);
      expect(mini.record()!.offers, what).toEqual(await mini.live());
    };

    // Nothing that the record says: no write.
    await step('a group added', () => mini.workspace.addGroup('Later'), 1);
    await step('the tabs moved', () => mini.workspace.setUiState(JSON.stringify({ tabs: ['a'] })), 1);
    await step('the agents asked again, answering the same', () => mini.runtime.agentAvailability(), 1);

    // Each change source.
    await step('a preset added', async () => mini.runtime.whoDoesWhat.set({ ...(await mini.runtime.whoDoesWhat.current()), presets: [{ name: 'Quick', agent: 'codex', model: '', effort: '', fast: false }] }), 2);
    await step('the box’s choices changed', () => mini.workspace.setUiState(JSON.stringify({ remembered: { agent: 'codex', projectId: null, byAgent: { codex: { model: 'wren-3', effort: 'high', fast: false, permission: 'auto' } } } })), 3);
    await step('the switch turned off', () => mini.runtime.remoteStarts.setAllowed(false), 4);
    await step('a project added', () => createProject(mini.workspace, { name: 'Blog' }), 5);
    await step('an agent signed out, as the window found when it asked', async () => {
      mini.agents.codex = { available: false, reason: 'Codex is not signed in.', models: [] };
      await mini.runtime.agentAvailability();
    }, 6);
    await step('a project kept off', () => mini.setKeptOff([project.id]), 7);
    expect(JSON.stringify(mini.record())).not.toContain(project.id);

    // A burst is one write.
    await step('a burst', async () => {
      await mini.runtime.remoteStarts.setAllowed(true);
      await createProject(mini.workspace, { name: 'Docs' });
      await mini.runtime.whoDoesWhat.set({ ...(await mini.runtime.whoDoesWhat.current()), presets: [] });
    }, 8);
  });

  it('two computers each read the other’s, kept on disk for the window', async () => {
    const { service, keys } = await account();
    const mini = await computer(service, keys, MINI);
    const laptop = await computer(service, keys, LAPTOP);
    await createProject(mini.workspace, { name: 'Shop' });
    await createProject(laptop.workspace, { name: 'Blog' });
    const pushed: unknown[] = [];
    laptop.workspace.accountOffers.onChange((view) => pushed.push(view));
    mini.sync.connected();
    laptop.sync.connected();
    await Promise.all([mini.sync.settled(), laptop.sync.settled()]);
    // Each reads before it writes: a second pass reads what the other wrote.
    await Promise.all([mini.sync.run(), laptop.sync.run()]);

    const onLaptop = await laptop.workspace.accountOffers.view();
    expect(Object.keys(onLaptop)).toEqual([MINI.id]);
    expect(onLaptop[MINI.id]!.machine).toEqual(MINI);
    expect(onLaptop[MINI.id]!.offers).toEqual(await mini.live());
    const onMini = await mini.workspace.accountOffers.view();
    expect(Object.keys(onMini)).toEqual([LAPTOP.id]);
    expect(onMini[LAPTOP.id]!.offers).toEqual(await laptop.live());
    expect(pushed.length).toBeGreaterThan(0);

    // A change on the mini reaches the laptop on its next reading of the feed.
    await mini.runtime.remoteStarts.setAllowed(false);
    await mini.settle();
    await laptop.sync.run();
    expect((await laptop.workspace.accountOffers.view())[MINI.id]!.offers.allowed).toBe(false);

    // Signed out: nothing of the account stays.
    await laptop.sync.forget();
    expect(await laptop.workspace.accountOffers.view()).toEqual({});
  });

  it('leaves out a project kept off, live and held alike', async () => {
    const { service, keys } = await account();
    const mini = await computer(service, keys, MINI);
    await createProject(mini.workspace, { name: 'Shop' });
    const secret = await createProject(mini.workspace, { name: 'Secret plans' });
    mini.setKeptOff([secret.id]);
    mini.sync.connected();
    await mini.sync.settled();
    const plain = JSON.stringify(mini.record());
    expect(plain).toContain('Shop');
    expect(plain).not.toContain('Secret plans');
    expect(plain).not.toContain(secret.id);
    expect(JSON.stringify(await mini.live())).not.toContain('Secret plans');
  });
});

describe('nothing secret in what a computer offers', () => {
  const SECRETS = {
    githubToken: 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
    apiKey: 'sk-ant-' + 'api03-Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe',
    slack: 'xoxb-' + '1234567890-abcdefghijkl',
    jwt: 'eyJhbGciOiJIUzI1NiJ9.' + 'eyJzdWIiOiJtZSJ9.' + 'c2lnbmF0dXJlLXNpZ25hdHVyZQ',
    email: 'someone.private' + '@example-mail.test',
    envValue: 'Bearer ' + 'Q2hhbmdlTWVQbGVhc2VUaGlzSXNBU2VjcmV0',
  };

  it('with secrets planted in provider configuration, the environment and MCP settings, the sealed plaintext has none', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-offers-home-')));
    // MCP and agent settings in the home folder, as Claude and Codex keep them.
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: SECRETS.apiKey }, mcpServers: { linear: { command: 'npx', env: { LINEAR_TOKEN: SECRETS.slack }, headers: { Authorization: SECRETS.envValue } } } }));
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'config.toml'), `[model_providers.corp]\nbase_url = "https://user:${SECRETS.githubToken}@llm.example.test"\n`);
    // The environment.
    const before = { ...process.env };
    process.env.GITHUB_TOKEN = SECRETS.githubToken;
    process.env.KESTREL_TEST_SECRET = SECRETS.envValue;
    closing.push(() => {
      for (const k of ['GITHUB_TOKEN', 'KESTREL_TEST_SECRET']) if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    });

    const { service, keys } = await account();
    const user = 'quillon';
    const mini = await computer(service, keys, MINI, { home, user });
    // What an agent answers, as read from its provider configuration: a reason that echoes a key and the account it is signed in as, and models named from a proxy's config.
    mini.agents.codex = { available: false, reason: `Codex could not reach https://user:${SECRETS.githubToken}@llm.example.test as ${SECRETS.email} (token ${SECRETS.jwt}); see ${home}/.codex/config.toml`, models: [] };
    mini.agents.claude = { available: true, models: [{ id: '', label: 'Default' }, { id: 'corp-1', label: `Corp (${SECRETS.apiKey})`, description: `key ${SECRETS.slack}` }] };
    mini.agents.opencode = { available: false, reason: `Not signed in as ${user} (${SECRETS.email}); found /opt/tools/${user}/bin/opencode and ${home.toUpperCase()}/bin; key=${SECRETS.slack}`, models: [] };
    await mini.runtime.whoDoesWhat.set({ ...(await mini.runtime.whoDoesWhat.current()), presets: [{ name: `Mine ${SECRETS.email}`, agent: 'claude', model: 'corp-1', effort: '', fast: false }] });
    mkdirSync(join(home, 'Code', 'shop'), { recursive: true });
    await createProject(mini.workspace, { name: 'Shop', folders: [join(home, 'Code', 'shop')] });

    mini.sync.connected();
    await mini.sync.settled();
    const plain = JSON.stringify(mini.record());
    expect(plain.length).toBeGreaterThan(100);
    for (const [name, secret] of Object.entries(SECRETS)) expect(plain, name).not.toContain(secret);
    expect(plain.toLowerCase()).not.toContain(home.toLowerCase());
    expect(plain.toLowerCase()).not.toContain(user);
    expect(plain).toContain(HIDDEN);
    // And the service holds only ciphertext.
    for (const secret of Object.values(SECRETS)) expect(JSON.stringify([...service.records.values()])).not.toContain(secret);
  });
});

describe('what is read, and when', () => {
  it('a change here writes without reading the feed, and a write that changes nothing it lists asks nothing', async () => {
    const { service, keys } = await account();
    const mini = await computer(service, keys, MINI);
    mini.sync.connected();
    await mini.sync.settled();
    mini.calls.length = 0;

    // As a streaming session's writes and a moved tab do: nothing the record is made from.
    await mini.workspace.addGroup('Later');
    await mini.workspace.addGroup('Sooner');
    await mini.workspace.setUiState(JSON.stringify({ tabs: ['a'] }));
    await mini.settle();
    expect(mini.calls).toEqual([]);

    await createProject(mini.workspace, { name: 'Shop' });
    await mini.settle();
    expect(mini.calls).toEqual([expect.stringMatching(/^PUT \/held\/records\//)]);
  });

  it('writes its own even when reading the others failed', async () => {
    const { service, keys } = await account();
    const mini = await computer(service, keys, MINI);
    mini.failNextRead();
    mini.sync.connected();
    await mini.sync.settled();
    expect(mini.record()!.offers).toEqual(await mini.live());
  });

  it('rewrites after the link comes up again, even while a pass was under way', async () => {
    const { service, keys } = await account();
    const mini = await computer(service, keys, MINI);
    // The link comes up again while the first write is on its way: the write owed after it is still made.
    const call = service.call.bind(service);
    let once = true;
    vi.spyOn(service, 'call').mockImplementation(async (...args: Parameters<typeof service.call>) => {
      if (args[1] === 'PUT' && once) {
        once = false;
        mini.sync.connected();
      }
      return call(...args);
    });
    mini.sync.connected();
    await mini.sync.settled();
    expect(mini.sync.writes).toBe(2);
    // Up again with nothing in flight: written again, changed or not.
    mini.sync.connected();
    await mini.sync.settled();
    expect(mini.sync.writes).toBe(3);
  });

  it('refuses a record too large, and one whose writer or id is not its machine’s', async () => {
    const { service, keys } = await account();
    const laptop = await computer(service, keys, LAPTOP);
    const key = keys.ready()!;
    const tag = (label: string) => tagOf(key.idKey, label);
    const put = (writer: Machine, under: Machine, says: Machine, offers: unknown) => {
      const id = tag(offersLabel(under.id));
      const body = sealRecord(key.adk, 'record', id, key.generation, offersRecordOf(says, 1000, offers as RemoteStartChoices));
      return service.call(writer.id, 'PUT', `/held/records/${encodeURIComponent(id)}`, { generation: key.generation, session: null, project: null, list: tag(OFFERS_LIST), body });
    };
    const offers = await laptop.live();
    // Written by the laptop under the mini's id, saying it is the mini.
    await put(LAPTOP, MINI, MINI, offers);
    laptop.sync.kick();
    await laptop.sync.settled();
    expect(await laptop.workspace.accountOffers.view()).toEqual({});
    // Written by the mini under its own id, saying it is the laptop.
    await put(MINI, MINI, LAPTOP, offers);
    laptop.sync.kick();
    await laptop.sync.settled();
    expect(await laptop.workspace.accountOffers.view()).toEqual({});
    // The mini's own, but over the size a record may be.
    const big = { ...(offers as RemoteStartChoices), projects: Array.from({ length: 400 }, (_, i) => ({ id: `p${i}`, name: 'x'.repeat(800), folders: [], defaultFolderId: null })) };
    await put(MINI, MINI, MINI, big);
    expect(sealRecord(key.adk, 'record', 'x', key.generation, big).length).toBeGreaterThan(MAX_OFFERS_BODY);
    laptop.sync.kick();
    await laptop.sync.settled();
    expect(await laptop.workspace.accountOffers.view()).toEqual({});
    // The mini's own, as it should be: taken.
    await put(MINI, MINI, MINI, offers);
    laptop.sync.kick();
    await laptop.sync.settled();
    expect(Object.keys(await laptop.workspace.accountOffers.view())).toEqual([MINI.id]);
  });
});
