// Update now from Settings → Connections (worker-nodes.md 4.2): `node.update` asked of a worker node of the account,
// through the remote calls every action uses; a stand-in answers, nothing is reached.
import { describe, expect, test } from 'vitest';
import type { ConnectDevice } from '../../shared/connect.ts';
import { nodeSettingRoute, restartNodeRoute, updateNodeRoute } from './api.ts';
import type { KestrelConnect } from './connect.ts';
import type { RemoteAnswer } from './remote-sessions.ts';

const device = (over: Partial<ConnectDevice>): ConnectDevice => ({ id: 'node-1', name: 'Worker node 1', kind: 'node', inAccount: true, connected: true, here: false, ...over });

function connect(devices: ConnectDevice[], answer: RemoteAnswer) {
  const asked: { machine: string; op: string; args?: unknown }[] = [];
  const fake = {
    view: () => ({ devices }),
    remote: {
      ask: async (machine: string, op: string, args?: unknown) => {
        asked.push({ machine, op, ...(args && Object.keys(args).length ? { args } : {}) });
        return answer;
      },
    },
  } as unknown as Pick<KestrelConnect, 'view' | 'remote'>;
  return { fake, asked };
}

describe('Update now on a worker node', () => {
  test('asks the node and answers what it said', async () => {
    const result = { to: '0.0.35', started: false, waitingFor: ['Fix login'], text: 'Worker node 1 is on 0.0.34; it updates to 0.0.35 when its sessions finish.' };
    const c = connect([device({})], { ok: true, result });
    expect(await updateNodeRoute(c.fake, 'node-1')).toEqual({ status: 200, body: result });
    expect(c.asked).toEqual([{ machine: 'node-1', op: 'node.update' }]);
  });

  test('a desktop, a device not in the account or an unknown one is not asked', async () => {
    const c = connect([device({ id: 'mini', name: 'Mac mini', kind: 'desktop' }), device({ id: 'new', inAccount: false })], { ok: true, result: null });
    expect(await updateNodeRoute(c.fake, 'mini')).toEqual({ status: 409, body: { error: 'Mac mini is not a worker node: it is updated as an app.' } });
    expect((await updateNodeRoute(c.fake, 'new')).status).toBe(409);
    expect((await updateNodeRoute(c.fake, 'gone')).status).toBe(409);
    expect(c.asked).toEqual([]);
  });

  test('a node that cannot be reached says so, naming it', async () => {
    const c = connect([device({})], { ok: false, reached: false, reason: 'no channel' });
    const answer = await updateNodeRoute(c.fake, 'node-1');
    expect(answer.status).toBe(503);
    expect(JSON.stringify(answer.body)).toContain('Worker node 1');
  });
});

describe("a worker node's settings and Restart from its page (section 10)", () => {
  const published = {
    settings: { name: 'Worker node 1', remoteStarts: true, agent: 'claude', model: '', mode: 'ask', autoReviews: false, projects: 'every', push: false, followDesktopVersion: true },
    facts: { agents: { claude: 'Can run', codex: 'Can run', opencode: 'Can run' }, git: '', sandbox: 'Available', lingering: 'On', freeDisk: '9 GB free.', projects: '' },
  };

  test('sends one key and one value, and holds what the node answered in its record', async () => {
    const c = connect([device({})], { ok: true, result: published });
    const held: unknown[] = [];
    const answer = await nodeSettingRoute(c.fake, { takeNodeAnswer: async (id, node) => Boolean(held.push([id, node])) }, 'node-1', { key: 'push', value: false });
    expect(answer).toEqual({ status: 200, body: published });
    expect(c.asked).toEqual([{ machine: 'node-1', op: 'node.settings.set', args: { key: 'push', value: false } }]);
    expect(held).toEqual([['node-1', published]]);
  });

  test('a key not on the list or a value out of range is refused here and not sent', async () => {
    const c = connect([device({})], { ok: true, result: published });
    expect(await nodeSettingRoute(c.fake, null, 'node-1', { key: 'crashReports', value: false })).toMatchObject({ status: 400 });
    expect(await nodeSettingRoute(c.fake, null, 'node-1', { key: 'mode', value: 'bypass' })).toMatchObject({ status: 400, body: { error: expect.stringContaining('never Bypass') } });
    expect(c.asked).toEqual([]);
  });

  test("the node's refusal is said in its words; one that cannot be reached is named", async () => {
    const refused = connect([device({})], { ok: false, reached: true, reason: 'OpenCode is not on Worker node 1.' });
    expect(await nodeSettingRoute(refused.fake, null, 'node-1', { key: 'agent', value: 'opencode' })).toEqual({ status: 409, body: { error: 'OpenCode is not on Worker node 1.' } });
    const away = connect([device({})], { ok: false, reached: false, reason: 'no channel' });
    expect(JSON.stringify((await nodeSettingRoute(away.fake, null, 'node-1', { key: 'push', value: true })).body)).toContain('Worker node 1');
  });

  test('Restart asks the node; never a desktop', async () => {
    const c = connect([device({}), device({ id: 'mini', name: 'Mac mini', kind: 'desktop' })], { ok: true, result: { text: 'Worker node 1 is restarting.' } });
    expect(await restartNodeRoute(c.fake, 'node-1')).toEqual({ status: 200, body: { text: 'Worker node 1 is restarting.' } });
    expect(await restartNodeRoute(c.fake, 'mini')).toMatchObject({ status: 409 });
    expect(c.asked).toEqual([{ machine: 'node-1', op: 'node.restart' }]);
  });
});
