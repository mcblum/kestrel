// Copying a set-up step's missing values from another computer, end to end on the fake service and relay
// (onboarding.md section 19): the Mac mini clicks Copy values, the MacBook Pro's person says Allow, and the
// values land in the Mac mini's MCP list and settings file. The relay and the service see ciphertext only;
// no value reaches a log, the workspace, the run state, the list, the request card or the record of what was sent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectDispatcher } from '../dispatcher.ts';
import { NEVER_REMOTE } from '../../shared/connect-ops.ts';
import type { SetupAction } from '../../shared/setup-list.ts';
import { SETUP_RECORD_VERSION, type SetupRecord } from '../../shared/setup-record.ts';
import { SETUP_ANSWERS, SETUP_SENT_KEY } from '../../shared/setup-values.ts';
import { askAgentText } from '../../shared/setup-agent.ts';
import type { StepContext } from '../../setup-actions/steps.ts';
import { until } from '../../test-agent.ts';
import type { ConnectDeps } from './connect.ts';
import { account, closeDesks } from './two-desks.ts';

const TOKEN = 'tok-SECRET-4c1e9d2b';
const URL_VALUE = 'http://ha.SECRET.internal:8123';
const SETTINGS_VALUE = 'settings-SECRET-77aa';
const SECRETS = [TOKEN, URL_VALUE, SETTINGS_VALUE];
/** Every way a value could be carried that is not sealed: as it is, in base64, in hex. */
const spellings = SECRETS.flatMap((s) => [s, Buffer.from(s).toString('base64'), Buffer.from(s).toString('hex')]);
const holdsAValue = (text: string) => spellings.some((s) => text.includes(s));

function record(id: string, name: string, extra: Partial<SetupRecord> = {}, answers: readonly string[] | null = SETUP_ANSWERS): SetupRecord {
  return { v: SETUP_RECORD_VERSION, kind: 'setup', machine: { id, name, platform: 'mac', ...(answers ? { answers } : {}) }, readAt: Date.now(), agents: [], hosts: [], git: { name: null, email: null, signs: false, format: null, signingKey: null }, ssh: { hosts: [], keyFiles: [] }, mcp: [], files: [], tools: [], projects: [], problems: [], ...extra };
}

const ha = { name: 'home-assistant', scope: 'user' as const, transport: 'stdio' as const, command: 'uvx', args: ['ha-mcp'], url: null, env: ['HOMEASSISTANT_URL', 'HOMEASSISTANT_TOKEN', 'HOMEASSISTANT_EXTRA'], headers: [], blanks: [{ kind: 'env' as const, name: 'HOMEASSISTANT_URL' }, { kind: 'env' as const, name: 'HOMEASSISTANT_TOKEN' }, { kind: 'env' as const, name: 'HOMEASSISTANT_EXTRA' }], appProgram: null };
const settingsFile = { agent: 'claude' as const, kind: 'settings' as const, path: '~/.claude/settings.json', files: 1, keyAt: null, env: ['MY_TOKEN'], plugins: [] };

/** The MacBook Pro: it has home-assistant's values in `~/.claude.json` (but not HOMEASSISTANT_EXTRA) and a settings file's. */
function laptopSetup(answers: readonly string[] | null = SETUP_ANSWERS, ttl?: number): ConnectDeps['setup'] {
  return {
    inventory: async (desk) => record(desk.id, desk.name, { mcp: [ha], files: [settingsFile] }, answers),
    checks: { tool: () => true },
    values: {
      home: '/home/me',
      mcpServers: () => [{ name: 'home-assistant', scope: 'user', kind: 'stdio', where: 'uvx', config: { command: 'uvx', env: { HOMEASSISTANT_URL: URL_VALUE, HOMEASSISTANT_TOKEN: TOKEN } } }],
      readText: () => JSON.stringify({ env: { MY_TOKEN: SETTINGS_VALUE } }),
      ...(ttl ? { requestTtlMs: ttl } : {}),
    },
  };
}

/** The Mac mini: nothing yet; Kestrel's MCP list and the settings step are in memory. */
function miniSetup() {
  const servers = new Map<string, Record<string, string>>();
  const written: Record<string, string>[] = [];
  const setup: ConnectDeps['setup'] = {
    inventory: async (desk) => record(desk.id, desk.name),
    checks: {
      tool: () => true,
      mcp: (name) => (!servers.has(name) ? 'missing' : Object.keys(servers.get(name)!).length === 3 ? 'ready' : 'needs-values'),
      mcpMissing: (name) => (servers.has(name) ? ['HOMEASSISTANT_URL', 'HOMEASSISTANT_TOKEN', 'HOMEASSISTANT_EXTRA'].filter((k) => !servers.get(name)![k]) : null),
    },
    execute: async (action: SetupAction, ctx: StepContext) => {
      if (action.kind === 'mcp') {
        servers.set(action.server.name, {});
        return { state: 'done', said: "Added to Kestrel's MCP servers.", undo: async () => void servers.delete(action.server.name) };
      }
      if (action.kind === 'files') {
        written.push({ ...ctx.input });
        return { state: 'done', said: 'Wrote one file.', undo: async () => undefined };
      }
      return { state: 'failed', reason: 'not in this test', output: '' };
    },
    mcp: {
      has: async (name) => servers.has(name),
      fill: async (name, values) => {
        const before = servers.get(name) ?? {};
        const keys = Object.keys(values).filter((k) => !before[k]);
        servers.set(name, { ...before, ...Object.fromEntries(keys.map((k) => [k, values[k]!])) });
        return keys;
      },
      clear: async (name, keys) => void servers.set(name, Object.fromEntries(Object.entries(servers.get(name) ?? {}).filter(([k]) => !keys.includes(k)))),
    },
  };
  return { setup, servers, written };
}

let logged: string[] = [];
beforeEach(() => {
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeDesks();
});

async function desks(laptop: ConnectDeps['setup'] = laptopSetup()) {
  const mini = miniSetup();
  const a = await account({ laptop, mini: mini.setup });
  await a.laptop.desk.setup!.write();
  await a.mini.desk.setup!.write();
  return { ...a, miniSetup: mini };
}

/** Waits for the MacBook Pro's card and answers it. */
async function answerOnLaptop(a: Awaited<ReturnType<typeof desks>>, allow: boolean) {
  const values = a.laptop.desk.values!;
  await until(() => values.view().length === 1, 'the MacBook Pro shows the request');
  const card = values.view()[0]!;
  return { card, report: await values.answer(card.id, allow) };
}

describe('Copy values from another computer', () => {
  it('copies on Allow there, writes where a typed value goes, says names only, and the relay and service see ciphertext only', async () => {
    const a = await desks();
    const list = await a.mini.desk.steps!.list();
    const line = list.lines.find((l) => l.id === 'mcp:home-assistant')!;
    expect(line.copy).toMatchObject({ offers: [{ id: a.laptop.id(), name: 'MacBook Pro', older: false }] });
    expect(JSON.stringify(list)).not.toSatisfy(holdsAValue);

    const copying = a.mini.desk.copyValues('mcp:home-assistant', a.laptop.id());
    const { card, report } = await answerOnLaptop(a, true);
    expect(card).toMatchObject({ from: { id: a.mini.id(), name: 'Mac mini' }, step: 'MCP server home-assistant', names: ['HOMEASSISTANT_URL', 'HOMEASSISTANT_TOKEN', 'HOMEASSISTANT_EXTRA'] });
    expect(report).toEqual({ to: 'Mac mini', step: 'MCP server home-assistant', sent: ['HOMEASSISTANT_URL', 'HOMEASSISTANT_TOKEN'], notThere: ['HOMEASSISTANT_EXTRA'] });
    const copied = await copying;
    expect(copied).toMatchObject({ from: 'MacBook Pro', copied: ['HOMEASSISTANT_URL', 'HOMEASSISTANT_TOKEN'], notThere: ['HOMEASSISTANT_EXTRA'], said: 'Copied HOMEASSISTANT_URL and HOMEASSISTANT_TOKEN from MacBook Pro into home-assistant. Not on MacBook Pro: HOMEASSISTANT_EXTRA; type it here.' });
    expect(a.miniSetup.servers.get('home-assistant')).toEqual({ HOMEASSISTANT_URL: URL_VALUE, HOMEASSISTANT_TOKEN: TOKEN });

    // The settings file: its own step writes it, the values as its typed input.
    const second = a.mini.desk.copyValues('file:~/.claude/settings.json', a.laptop.id());
    await answerOnLaptop(a, true);
    expect((await second).copied).toEqual(['MY_TOKEN']);
    expect(a.miniSetup.written).toEqual([{ [`value:~/.claude/settings.json:${JSON.stringify(['env', 'MY_TOKEN'])}`]: SETTINGS_VALUE }]);

    // Ciphertext only on the relay and the service; nothing in any record the service holds.
    expect(a.relay.carried.length).toBeGreaterThan(0);
    expect(a.relay.carried.filter(holdsAValue)).toEqual([]);
    expect([...a.service.held.records.values()].map((r) => JSON.stringify(r)).filter(holdsAValue)).toEqual([]);

    // Nothing anywhere else on either computer.
    const everywhere = [
      JSON.stringify(copied),
      JSON.stringify(report),
      JSON.stringify(a.mini.desk.steps!.runs()),
      JSON.stringify(a.laptop.desk.steps!.runs()),
      JSON.stringify(await a.mini.desk.steps!.list()),
      JSON.stringify(a.laptop.desk.values!.view()),
      JSON.stringify(await a.laptop.workspace.state()),
      JSON.stringify(await a.mini.workspace.state()),
      JSON.stringify(a.mini.desk.view()),
      JSON.stringify(a.laptop.desk.view()),
      (await a.laptop.settings.getSetting(SETUP_SENT_KEY)) ?? '',
      ...(await a.mini.desk.steps!.list()).lines.map((l) => askAgentText(l, list, undefined, 'mac')),
      ...logged,
    ];
    expect(everywhere.filter(holdsAValue)).toEqual([]);
    expect(await a.laptop.desk.values!.sent()).toMatchObject([{ to: { name: 'Mac mini' }, names: ['MY_TOKEN'] }, { names: ['HOMEASSISTANT_URL', 'HOMEASSISTANT_TOKEN'], notThere: ['HOMEASSISTANT_EXTRA'] }]);
    expect(await a.mini.settings.getSetting(SETUP_SENT_KEY)).toBeNull();
  });

  it('Undo of a copy into a server already in the list clears exactly those values', async () => {
    const a = await desks();
    a.miniSetup.servers.set('home-assistant', { HOMEASSISTANT_EXTRA: 'typed here' });
    const copying = a.mini.desk.copyValues('mcp:home-assistant', a.laptop.id());
    await answerOnLaptop(a, true);
    const copied = await copying;
    expect(a.miniSetup.servers.get('home-assistant')).toEqual({ HOMEASSISTANT_EXTRA: 'typed here', HOMEASSISTANT_URL: URL_VALUE, HOMEASSISTANT_TOKEN: TOKEN });
    await a.mini.desk.steps!.undo(copied.undo!);
    expect(a.miniSetup.servers.get('home-assistant')).toEqual({ HOMEASSISTANT_EXTRA: 'typed here' });
  });

  it('Deny there: nothing is copied, sent or recorded', async () => {
    const a = await desks();
    const copying = a.mini.desk.copyValues('mcp:home-assistant', a.laptop.id());
    const refused = copying.catch((e: unknown) => (e as Error).message);
    expect((await answerOnLaptop(a, false)).report).toBeNull();
    expect(await refused).toBe('MacBook Pro said no.');
    expect(a.miniSetup.servers.has('home-assistant')).toBe(false);
    expect(await a.laptop.desk.values!.sent()).toEqual([]);
    expect(a.relay.carried.filter(holdsAValue)).toEqual([]);
  });

  it('no answer there in time: nothing is copied', async () => {
    const a = await desks(laptopSetup(SETUP_ANSWERS, 300));
    const refused = a.mini.desk.copyValues('mcp:home-assistant', a.laptop.id()).catch((e: unknown) => (e as Error).message);
    await until(() => a.laptop.desk.values!.view().length === 1, 'the request is shown');
    expect(await refused).toBe('MacBook Pro did not answer within 2 minutes.');
    expect(a.laptop.desk.values!.view()).toEqual([]);
    expect(a.miniSetup.servers.has('home-assistant')).toBe(false);
  });

  it('an older Kestrel there is said, and not asked', async () => {
    const a = await desks(laptopSetup(null));
    const line = (await a.mini.desk.steps!.list()).lines.find((l) => l.id === 'mcp:home-assistant')!;
    expect(line.copy?.offers[0]).toMatchObject({ name: 'MacBook Pro', older: true });
    await expect(a.mini.desk.copyValues('mcp:home-assistant', a.laptop.id())).rejects.toThrow('Update Kestrel on MacBook Pro to copy values from it.');
    expect(a.laptop.desk.values!.view()).toEqual([]);
  });

  it('a phone asking is refused in words by the dispatcher, before anything is shown or read', async () => {
    const a = await desks();
    const ask = vi.fn();
    const dispatcher = new ConnectDispatcher({ workspace: a.laptop.workspace, runtime: a.laptop.runtime, deviceId: a.laptop.id(), here: 'MacBook Pro', send: () => undefined, keptOff: () => [], desk: { kindOf: () => 'phone', values: { ask, withdraw: vi.fn(), dropDevice: vi.fn(), close: vi.fn() } } });
    expect(await dispatcher.answer('iphone', { op: 'setup.values', args: { requestId: 'r1', line: 'mcp:home-assistant', names: ['HOMEASSISTANT_TOKEN'] } })).toEqual({ ok: false, reason: NEVER_REMOTE.setup });
    expect(await dispatcher.answer('iphone', { op: 'setup.values.withdraw', args: { requestId: 'r1' } })).toEqual({ ok: false, reason: NEVER_REMOTE.setup });
    // A device the keyring does not know is no desktop either.
    const unknown = new ConnectDispatcher({ workspace: a.laptop.workspace, runtime: a.laptop.runtime, deviceId: a.laptop.id(), here: 'MacBook Pro', send: () => undefined, keptOff: () => [], desk: { kindOf: () => null, values: { ask, withdraw: vi.fn(), dropDevice: vi.fn(), close: vi.fn() } } });
    expect(await unknown.answer('who', { op: 'setup.values', args: { requestId: 'r1', line: 'mcp:home-assistant', names: ['HOMEASSISTANT_TOKEN'] } })).toEqual({ ok: false, reason: NEVER_REMOTE.setup });
    expect(ask).not.toHaveBeenCalled();
    dispatcher.close();
    unknown.close();
  });

  it('the keyring, not the request, says the asking computer is a desktop and what it is called', async () => {
    const a = await desks();
    expect(a.laptop.desk.keys.device(a.mini.id())).toEqual({ kind: 'desktop', name: 'Mac mini' });
    expect(a.laptop.desk.keys.device('nobody')).toBeNull();
  });
});
