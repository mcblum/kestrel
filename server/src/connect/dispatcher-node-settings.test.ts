// A worker node carrying out another computer's change to one of its settings, and its Restart (worker-nodes.md section
// 10): from a desktop of the keyring only, each by the setting's own store, a refusal in plain words. Nothing restarts.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter } from '../agents/types.ts';
import { SELECTABLE_AGENTS, type Agent } from '../model.ts';
import { memoryPersistence } from '../persistence/memory.ts';
import { NodeProjectPrefsStore } from '../project-clone/prefs.ts';
import { SessionRuntime } from '../runtime.ts';
import { CONNECT_PROTOCOL_VERSION, NEVER_REMOTE, type ConnectResponse } from '../shared/connect-ops.ts';
import type { DeviceKind } from '../shared/connect.ts';
import type { KestrelKind } from '../shared/host-kind.ts';
import { memorySettings } from '../suggestions/prefs.ts';
import { FakeAgents } from '../test-agent.ts';
import { Workspace } from '../workspace.ts';
import { NodeSettings } from '../node-settings/service.ts';
import { connectLists } from './lists.ts';
import { ConnectDispatcher } from './dispatcher.ts';

const NODE = 'Worker node 1';
const KINDS: Record<string, DeviceKind> = { 'mac-1': 'desktop', 'phone-1': 'phone' };
let open: ConnectDispatcher[] = [];
afterEach(() => {
  for (const d of open) d.close();
  open = [];
});

async function computer(kind: KestrelKind, running: string[] = []) {
  const workspace = new Workspace(memoryPersistence());
  const adapters = Object.fromEntries(SELECTABLE_AGENTS.map((a): [Agent, AgentAdapter] => [a, { ...new FakeAgents().adapter(), agent: a, availability: async () => ({ available: true }) }]));
  const runtime = new SessionRuntime(workspace, adapters, realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-node-'))), { window: { kind, name: NODE } });
  const projects = new NodeProjectPrefsStore(memorySettings());
  const restarts: string[] = [];
  let follow = true;
  const settings = new NodeSettings({
    kind,
    name: () => NODE,
    rename: async () => undefined,
    remoteStarts: runtime.remoteStarts,
    uiState: { get: () => workspace.getUiState(), set: (raw) => workspace.setUiState(raw) },
    reviews: runtime.reviewPrefs,
    projects,
    follow: { current: async () => follow, set: async (on) => void (follow = on) },
    agents: () => runtime.availableAgents(),
    models: async () => [],
    facts: async () => ({ agents: { claude: 'Can run', codex: 'Can run', opencode: 'Can run' }, git: '', sandbox: 'Available', lingering: 'On', freeDisk: '9 GB free.', projects: '' }),
    running: async () => running,
    service: async () => true,
    restartUnit: () => restarts.push('restarted'),
    later: (work) => work(),
  });
  runtime.useNodeSettings(settings);
  const dispatcher = new ConnectDispatcher({ workspace, runtime, deviceId: 'node-1', here: NODE, send: () => undefined, lists: connectLists(runtime.reviewPrefs, null, null), keptOff: () => [], kind, desk: { kindOf: (d) => KINDS[d] ?? null } });
  open.push(dispatcher);
  let n = 0;
  const ask = async (from: string, op: string, args: Record<string, unknown> = {}): Promise<ConnectResponse> => (await dispatcher.receive({ v: CONNECT_PROTOCOL_VERSION, from, to: 'node-1', kind: 'request', id: `q${++n}`, body: { op, args } }))!.body;
  return { runtime, projects, restarts, ask };
}

describe('node.settings.set', () => {
  it('a desktop changes one setting, by its own store, and is answered what the node publishes now', async () => {
    const node = await computer('node');
    const answer = await node.ask('mac-1', 'node.settings.set', { key: 'push', value: false });
    expect(answer).toMatchObject({ ok: true, result: { settings: { push: false } } });
    expect((await node.projects.current()).push).toBe(false);
    expect(await node.ask('mac-1', 'node.settings.set', { key: 'remoteStarts', value: false })).toMatchObject({ ok: true });
    expect((await node.runtime.remoteStarts.prefs()).allowed).toBe(false);
  });

  it('refuses a phone, a key not on the list and a value out of range, in plain words', async () => {
    const node = await computer('node');
    expect(await node.ask('phone-1', 'node.settings.set', { key: 'push', value: false })).toEqual({ ok: false, reason: NEVER_REMOTE['node.settings'] });
    expect(await node.ask('mac-1', 'node.settings.set', { key: 'sandboxAllow', value: [] })).toMatchObject({ ok: false, reason: expect.stringContaining('not a setting another computer may change') });
    expect(await node.ask('mac-1', 'node.settings.set', { key: 'mode', value: 'bypass' })).toMatchObject({ ok: false, reason: expect.stringContaining('never Bypass') });
    expect((await node.projects.current()).push).toBe(true);
  });

  it('a desktop that is not a node refuses', async () => {
    const mac = await computer('app');
    expect(await mac.ask('mac-1', 'node.settings.set', { key: 'push', value: false })).toMatchObject({ ok: false, reason: expect.stringContaining('is not a worker node') });
  });
});

describe('node.restart', () => {
  it('restarts from a desktop; never from a phone', async () => {
    const node = await computer('node');
    expect(await node.ask('phone-1', 'node.restart')).toEqual({ ok: false, reason: NEVER_REMOTE['node.restart'] });
    expect(node.restarts).toEqual([]);
    expect(await node.ask('mac-1', 'node.restart')).toMatchObject({ ok: true, result: { text: expect.stringContaining('is restarting') } });
    expect(node.restarts).toEqual(['restarted']);
  });

  it('is refused while a turn runs, naming the session', async () => {
    const node = await computer('node', ['Fix login']);
    expect(await node.ask('mac-1', 'node.restart')).toMatchObject({ ok: false, reason: expect.stringContaining('“Fix login”') });
    expect(node.restarts).toEqual([]);
  });
});
