// A worker node carrying out another device's requests about its agents (docs/designs/worker-nodes.md, section 6):
// what it offers, the refusal a start gets for an agent that cannot run there, and a turn that ends on a reason that
// lasts, all in the node's words and for every provider. The same runtime as the app's, started as a node.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, AvailabilityAnswer } from '../agents/types.ts';
import { SELECTABLE_AGENTS, type Agent } from '../model.ts';
import { NODE_AGENT_LABEL } from '../shared/node-agents.ts';
import { memoryPersistence } from '../persistence/memory.ts';
import { createProject } from '../project-store.ts';
import { SessionRuntime } from '../runtime.ts';
import { CONNECT_PROTOCOL_VERSION, type ConnectResponse } from '../shared/connect-ops.ts';
import type { KestrelKind } from '../shared/host-kind.ts';
import { FakeAgents } from '../test-agent.ts';
import { Workspace } from '../workspace.ts';
import { connectLists } from './lists.ts';
import { ConnectDispatcher } from './dispatcher.ts';

const NODE = 'Worker node 1';
let open: ConnectDispatcher[] = [];
afterEach(() => {
  for (const d of open) d.close();
  open = [];
});

/** A computer of `kind` whose agents answer `availability` as given. */
async function computer(kind: KestrelKind, answers: Partial<Record<Agent, AvailabilityAnswer>>) {
  const workspace = new Workspace(memoryPersistence());
  const fakes = Object.fromEntries(SELECTABLE_AGENTS.map((a) => [a, new FakeAgents()])) as Record<Agent, FakeAgents>;
  const adapters = Object.fromEntries(SELECTABLE_AGENTS.map((a): [Agent, AgentAdapter] => [a, { ...fakes[a].adapter(), agent: a, availability: async () => answers[a] ?? { available: true } }]));
  const runtime = new SessionRuntime(workspace, adapters, realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-node-'))), { window: { kind, name: NODE } });
  const project = await createProject(workspace, { name: 'Shop' });
  const here = kind === 'node' ? NODE : 'your Mac';
  const dispatcher = new ConnectDispatcher({ workspace, runtime, deviceId: 'node-1', here, send: () => undefined, lists: connectLists(runtime.reviewPrefs, null, null), keptOff: () => [], kind });
  open.push(dispatcher);
  let n = 0;
  const ask = async (op: string, args: Record<string, unknown> = {}): Promise<ConnectResponse> => (await dispatcher.receive({ v: CONNECT_PROTOCOL_VERSION, from: 'phone-1', to: 'node-1', kind: 'request', id: `q${++n}`, body: { op, args } }))!.body;
  return { runtime, workspace, project, fakes, ask };
}

const signedOut: AvailabilityAnswer = { available: false, reason: 'desk words: choose Sign in', signIn: true, problem: 'auth' };

describe.each(SELECTABLE_AGENTS)('a worker node and %s', (agent) => {
  it('lists it as missing in its offers, naming the node and the command, and refuses a start for it with the same words', async () => {
    const node = await computer('node', { [agent]: signedOut });
    const words = `${NODE_AGENT_LABEL[agent]} is not signed in on ${NODE}. Run \`kestrel node agents\` there.`;
    const offers = await node.ask('session.startChoices');
    expect(offers).toMatchObject({ ok: true, result: { here: NODE, missing: [{ agent, reason: words }] } });
    expect(await node.ask('session.start', { projectId: node.project.id, agent, mode: 'ask', text: 'go' })).toEqual({ ok: false, reason: words });
    expect((await node.workspace.state()).sessions).toEqual([]);
  });

  it('the app lets the start through as before, and keeps its own words', async () => {
    const mac = await computer('app', { [agent]: signedOut });
    expect(await mac.ask('session.startChoices')).toMatchObject({ ok: true, result: { here: 'your Mac', missing: [{ agent, reason: 'desk words: choose Sign in' }] } });
    expect(await mac.ask('session.start', { projectId: mac.project.id, agent, mode: 'ask', text: 'go' })).toMatchObject({ ok: true });
  });

  it('a turn its provider refuses for a reason that lasts: said on the session, and the node offers it no more until a turn succeeds', async () => {
    const node = await computer('node', {});
    node.fakes[agent].script = (turn) => turn.emit({ type: 'failed', reason: 'Free usage exceeded', kind: 'other' });
    const session = await node.runtime.start({ agent, projectId: node.project.id, prompt: 'go' });
    await node.fakes[agent].settled();
    await node.runtime.idle(session.id);
    const refused = `${NODE_AGENT_LABEL[agent]}'s provider refused the last turn on ${NODE} (Free usage exceeded). Run \`kestrel node agents\` there.`;
    expect(JSON.stringify(node.runtime.overlay(session.id)?.messages ?? [])).toContain(refused);
    expect((await node.runtime.agentAvailability()).notes[agent]).toBe(refused);
    expect(await node.ask('session.start', { projectId: node.project.id, agent, mode: 'ask', text: 'again' })).toEqual({ ok: false, reason: refused });
    // A turn that completes ends it.
    node.fakes[agent].script = (turn) => turn.done();
    await node.runtime.reply(session.id, 'try again');
    await node.fakes[agent].settled();
    await node.runtime.idle(session.id);
    expect((await node.runtime.agentAvailability()).available).toContain(agent);
  });

  it('`kestrel node agents` signing it in again makes the node forget the refusal', async () => {
    const node = await computer('node', {});
    node.fakes[agent].script = (turn) => turn.emit({ type: 'failed', reason: 'Your credit balance is too low', kind: 'other' });
    const session = await node.runtime.start({ agent, projectId: node.project.id, prompt: 'go' });
    await node.fakes[agent].settled();
    await node.runtime.idle(session.id);
    expect((await node.runtime.agentAvailability()).available).not.toContain(agent);
    expect((await node.runtime.recheckAgents([agent])).available).toContain(agent);
  });
});
