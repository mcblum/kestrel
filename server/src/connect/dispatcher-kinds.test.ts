// Who may ask a `who: 'desk'` operation (worker-nodes.md, W2): a computer of this computer's keyring, a desktop or a
// worker node, and never a phone or a device the keyring does not list (one removed from the account).
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { AgentAdapter } from '../agents/types.ts';
import { SELECTABLE_AGENTS, type Agent } from '../model.ts';
import { memoryPersistence } from '../persistence/memory.ts';
import { SessionRuntime } from '../runtime.ts';
import { CONNECT_PROTOCOL_VERSION, NEVER_REMOTE, type ConnectResponse } from '../shared/connect-ops.ts';
import { isComputerKind, type DeviceKind } from '../shared/connect.ts';
import { FakeAgents } from '../test-agent.ts';
import { Workspace } from '../workspace.ts';
import { ConnectDispatcher } from './dispatcher.ts';

const HERE = 'here-1';
const KEYRING: Record<string, DeviceKind> = { 'desk-1': 'desktop', 'node-1': 'node', 'phone-1': 'phone' };

let open: ConnectDispatcher[] = [];
afterEach(() => {
  for (const d of open) d.close();
  open = [];
});

/** A computer whose keyring lists a desktop, a node and a phone; `withdrawn` records each desk-only call carried out. */
function computer(removed: ReadonlySet<string> = new Set()) {
  const workspace = new Workspace(memoryPersistence());
  const fake = new FakeAgents();
  const adapters = Object.fromEntries(SELECTABLE_AGENTS.map((a): [Agent, AgentAdapter] => [a, { ...fake.adapter(), agent: a }])) as Record<Agent, AgentAdapter>;
  const runtime = new SessionRuntime(workspace, adapters, realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-kinds-'))));
  const withdrawn: string[] = [];
  const values = { ask: async () => ({ values: {} }), withdraw: (device: string) => void withdrawn.push(device), dropDevice: () => undefined, close: () => undefined };
  const kindOf = (id: string): DeviceKind | null => (removed.has(id) ? null : (KEYRING[id] ?? null));
  const dispatcher = new ConnectDispatcher({ workspace, runtime, deviceId: HERE, here: 'this computer', send: () => undefined, keptOff: () => [], desk: { kindOf, values: values as never } });
  open.push(dispatcher);
  let n = 0;
  const ask = async (from: string, op: string, args: Record<string, unknown>): Promise<ConnectResponse> => (await dispatcher.receive({ v: CONNECT_PROTOCOL_VERSION, from, to: HERE, kind: 'request', id: `q${++n}`, body: { op, args } }))!.body;
  return { ask, withdrawn };
}

describe('desk-only operations by device kind', () => {
  test('a worker node may ask one, as a desktop may', async () => {
    // Arrange
    const here = computer();
    // Act
    const fromNode = await here.ask('node-1', 'setup.values.withdraw', { requestId: 'r1' });
    const fromDesk = await here.ask('desk-1', 'setup.values.withdraw', { requestId: 'r2' });
    // Assert
    expect(fromNode).toEqual({ ok: true, result: {} });
    expect(fromDesk).toEqual({ ok: true, result: {} });
    expect(here.withdrawn).toEqual(['node-1', 'desk-1']);
  });

  test('a phone still may not, with the reason', async () => {
    const here = computer();
    expect(await here.ask('phone-1', 'setup.values.withdraw', { requestId: 'r1' })).toEqual({ ok: false, reason: NEVER_REMOTE.setup });
    expect(here.withdrawn).toEqual([]);
  });

  test('a node removed from the account (no longer in the keyring here) is refused', async () => {
    const here = computer(new Set(['node-1']));
    expect(await here.ask('node-1', 'setup.values.withdraw', { requestId: 'r1' })).toEqual({ ok: false, reason: NEVER_REMOTE.setup });
    expect(here.withdrawn).toEqual([]);
  });

  test('a computer is a desktop or a node, never a phone or nothing', () => {
    expect(['desktop', 'node', 'phone', null, undefined].map((k) => isComputerKind(k as DeviceKind | null))).toEqual([true, true, false, false, false]);
  });
});
