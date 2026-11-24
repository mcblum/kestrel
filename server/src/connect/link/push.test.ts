// Push notifications from the desk (push.ts) against the fake service: the window's own rule run in the
// server, so a phone is told with no window open; sealed under the account key, never readable by the
// service; each phone's own choices; an Allow / Deny card for the banner only when it is plain (D6).
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter } from '../../agents/types.ts';
import { SELECTABLE_AGENTS, type Agent, type ChatMessage } from '../../model.ts';
import { memoryPersistence } from '../../persistence/memory.ts';
import { createProject } from '../../project-store.ts';
import { SessionRuntime } from '../../runtime.ts';
import type { NotifyNow } from '../../shared/notifications.ts';
import { FakeAgents } from '../../test-agent.ts';
import { Workspace } from '../../workspace.ts';
import { openRecord, sealRecord } from '../account-key.ts';
import { newIdentity } from '../keys.ts';
import { AccountKeys, type KeysTrust } from './account-keys.ts';
import { FakeHeldService } from './connect-fakes.ts';
import { HeldApi } from './held-api.ts';
import { PushApi } from './push-api.ts';
import { phoneEvents, plainCard, PushNotices, pushSource, type PushPayload, type PushSource } from './push.ts';

const MAC = 'mac-1';
let closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing) close();
  closing = [];
});

async function openKeys(service: FakeHeldService) {
  service.addDevice(MAC, 'Studio Mac', 'desktop');
  const identity = newIdentity();
  let trust: KeysTrust | null = null;
  const keys = new AccountKeys({
    api: () => new HeldApi((m, p, b) => service.call(MAC, m, p, b)),
    me: () => ({ id: MAC, name: 'Studio Mac', identity }),
    trust: () => trust,
    saveTrust: async (next) => void (trust = next),
    changed: () => undefined,
  });
  await keys.sync();
  return keys;
}

function sender(service: FakeHeldService, keys: AccountKeys, source: PushSource, online: () => boolean = () => true) {
  const push = new PushNotices({
    source,
    api: () => (online() ? new PushApi((m, p, b) => service.call(MAC, m, p, b)) : null),
    key: () => keys.ready(),
    keyFor: (g) => keys.keyFor(g),
    desk: () => ({ id: MAC, name: 'Studio Mac' }),
    changed: () => undefined,
    lookMs: 60_000,
  });
  closing.push(() => push.close());
  return push;
}

/** What a phone's extension does with a push: opens it with the account key. */
function opened(keys: AccountKeys, push: { id: string; generation: number; body: string }): PushPayload {
  return openRecord(keys.keyFor(push.generation), push.body, 'push', push.id, push.generation) as PushPayload;
}

function phone(service: FakeHeldService, keys: AccountKeys, id: string, events?: Record<string, boolean>) {
  service.addDevice(id, `Phone ${id}`, 'phone');
  const key = keys.ready()!;
  service.registerPhone(id, `token-${id}`, events ? { generation: key.generation, body: sealRecord(key.adk, 'push-prefs', id, key.generation, { v: 1, events }) } : null);
}

const approval = (id: string, options = [{ id: 'yes', label: 'Allow', role: 'allow' as const }, { id: 'no', label: 'Deny', role: 'deny' as const }]) => ({
  type: 'needs-input' as const,
  request: { id, kind: 'approval' as const, title: 'Run a command', detail: 'pnpm install', tool: 'Bash', options },
});

describe.each(SELECTABLE_AGENTS)('a push for a %s session', (agent) => {
  it('is sent with no window open when the session needs an answer, sealed, with the card the banner may answer', async () => {
    const service = new FakeHeldService();
    const keys = await openKeys(service);
    phone(service, keys, 'phone-1');
    const workspace = new Workspace(memoryPersistence());
    const fakes = Object.fromEntries(SELECTABLE_AGENTS.map((a) => [a, new FakeAgents()])) as Record<Agent, FakeAgents>;
    const adapters = Object.fromEntries(SELECTABLE_AGENTS.map((a): [Agent, AgentAdapter] => [a, { ...fakes[a].adapter(), agent: a }]));
    const runtime = new SessionRuntime(workspace, adapters, realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-push-'))));
    const project = await createProject(workspace, { name: 'Shop' });
    const session = await runtime.start({ agent, projectId: project.id, prompt: 'set it up' });
    await fakes[agent].settled();
    await runtime.idle(session.id);

    const push = sender(service, keys, pushSource(workspace, runtime, null, null));
    await push.settle(); // the first look: nothing is news
    expect(service.pushed).toEqual([]);

    fakes[agent].hold = true;
    fakes[agent].script = (turn) => turn.emit(approval('req-1'));
    await runtime.reply(session.id, 'install the packages', {});
    for (let i = 0; i < 20 && !(await workspace.state()).sessions.some((s) => s.id === session.id && s.state === 'attention'); i++) await new Promise((r) => setTimeout(r, 5));
    await push.settle();

    expect(service.pushed).toHaveLength(1);
    const sent = service.pushed[0]!;
    expect(sent.deviceId).toBe('phone-1');
    expect(opened(keys, sent)).toMatchObject({ v: 1, kind: 'needs-you', sessionId: session.id, desk: { id: MAC, name: 'Studio Mac' }, card: { sessionId: session.id, requestId: 'req-1', allow: 'yes', deny: 'no' } });
    // The service has the ciphertext only.
    const dump = JSON.stringify(service.pushed);
    for (const secret of ['pnpm', 'Shop', session.id, 'Studio Mac', 'needs-you']) expect(dump).not.toContain(secret);
  });
});

/** A source the test drives by hand. */
function stubSource(initial: NotifyNow) {
  let now = initial;
  const listeners = new Set<() => void>();
  const source: PushSource = {
    now: async () => now,
    card: async () => null,
    onChange: (listener) => (listeners.add(listener), () => void listeners.delete(listener)),
  };
  return { source, set: (next: Partial<NotifyNow>) => ((now = { ...now, ...next }), listeners.forEach((l) => l())) };
}

const session = (id: string, state: 'running' | 'done' | 'attention', note = '') => ({ id, title: `Session ${id}`, state, note });
const nothing: NotifyNow = { sessions: [], links: [], reviewRequests: { requests: [], unread: [] }, tickets: { tickets: [], unread: [], sources: [], settings: { on: true, off: [], show: 'page' } } };

describe('which phones are told', () => {
  it('each phone by its own choices; one with no choices is told everything; one with no token nothing', async () => {
    const service = new FakeHeldService();
    const keys = await openKeys(service);
    phone(service, keys, 'quiet', { done: false });
    phone(service, keys, 'all');
    service.addDevice('no-token', 'Old phone', 'phone');
    const stub = stubSource({ ...nothing, sessions: [session('a', 'running'), session('b', 'running')] });
    const push = sender(service, keys, stub.source);
    await push.settle();
    stub.set({ sessions: [session('a', 'done'), session('b', 'attention', 'Needs you · Approve?')] });
    await push.settle();
    const told = service.pushed.map((p) => [p.deviceId, opened(keys, p).kind]);
    expect(told).toEqual([['all', 'done'], ['quiet', 'needs-you'], ['all', 'needs-you']]);
    expect(push.view().phones.sort()).toEqual(['Phone all', 'Phone quiet']);
  });

  it('tells of a review request and a ticket, as the window does', async () => {
    const service = new FakeHeldService();
    const keys = await openKeys(service);
    phone(service, keys, 'p');
    const stub = stubSource(nothing);
    const push = sender(service, keys, stub.source);
    await push.settle();
    const request = { key: 'r1', host: 'github' as const, hostName: 'github.com', repository: 'acme/shop', number: 7, title: 'Faster checkout', author: 'sam', url: '', updatedAt: 0, projectId: null };
    const ticket = { key: 'fake:T-1', source: 'fake', tracker: 'Tracker', ref: 'T-1', title: 'Fix it', status: { name: 'To Do', category: 'todo' as const }, project: 'Shop', url: '', openedAt: 0, updatedAt: 0 };
    stub.set({ reviewRequests: { requests: [request], unread: ['r1'] }, tickets: { tickets: [ticket], unread: ['fake:T-1'], sources: ['fake'], settings: { on: true, off: [], show: 'page' } } });
    await push.settle();
    // The ticket's source was first asked in this push, so it is not news yet (the window's rule).
    expect(service.pushed.map((p) => opened(keys, p))).toMatchObject([{ kind: 'review-request', requestKey: 'r1', title: 'Faster checkout' }]);
  });

  it('sends nothing on the first look, and drops what happens while the link is down, with no backlog after', async () => {
    const service = new FakeHeldService();
    const keys = await openKeys(service);
    phone(service, keys, 'p');
    let online = false;
    const stub = stubSource({ ...nothing, sessions: [session('a', 'running')] });
    const push = sender(service, keys, stub.source, () => online);
    await push.settle();
    stub.set({ sessions: [session('a', 'done')] });
    await push.settle();
    online = true;
    stub.set({ sessions: [session('a', 'done')] });
    await push.settle();
    expect(service.pushed).toEqual([]);
  });

  it('a phone whose choices were sealed under a key since replaced is told every kind until it seals them again', async () => {
    const service = new FakeHeldService();
    const keys = await openKeys(service);
    expect(phoneEvents(null, null, 'p', (g) => keys.keyFor(g))).toMatchObject({ done: true, 'needs-you': true, ticket: true });
    expect(phoneEvents('not sealed', 1, 'p', (g) => keys.keyFor(g)).done).toBe(true);
    const key = keys.ready()!;
    expect(phoneEvents(sealRecord(key.adk, 'push-prefs', 'p', key.generation, { v: 1, events: { done: false } }), key.generation, 'p', (g) => keys.keyFor(g)).done).toBe(false);
    // Sealed for another phone: not this one's.
    expect(phoneEvents(sealRecord(key.adk, 'push-prefs', 'q', key.generation, { v: 1, events: { done: false } }), key.generation, 'p', (g) => keys.keyFor(g)).done).toBe(true);
  });
});

describe('the card a banner may answer (D6)', () => {
  const card = (input: ChatMessage['input']): ChatMessage => ({ id: 'm', role: 'assistant', text: '', at: 0, input }) as unknown as ChatMessage;
  it('only a plain approval with one allow and one deny, still open', () => {
    const plain = approval('r').request;
    expect(plainCard('s', [card(plain)])).toEqual({ sessionId: 's', requestId: 'r', allow: 'yes', deny: 'no' });
    expect(plainCard('s', [card({ ...plain, resolved: 'yes' })])).toBeNull();
    expect(plainCard('s', [card({ ...plain, options: [...plain.options, { id: 'always', label: 'Always allow', role: 'allow' }] })])).toBeNull();
    expect(plainCard('s', [card({ ...plain, kind: 'question' })])).toBeNull();
  });
});
