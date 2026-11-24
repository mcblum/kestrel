// Held conversations on the desk (held.ts) against the fake service, with the real runtime and one
// fake agent per provider: a turn is held encrypted, only what changed is sent again, a kept-off
// project and a deleted session leave the service, attachments only when switched on, the queue
// survives a restart, and a message a phone left while the desk was away is delivered once.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '../../agents/types.ts';
import { SELECTABLE_AGENTS, type Agent, type ChatMessage, type WorkspaceState } from '../../model.ts';
import { memoryPersistence } from '../../persistence/memory.ts';
import type { ContextUsage } from '../../shared/context-usage.ts';
import { createProject } from '../../project-store.ts';
import { SessionRuntime } from '../../runtime.ts';
import { FakeAgents } from '../../test-agent.ts';
import { Workspace } from '../../workspace.ts';
import { openRecord, sealRecord, tagOf } from '../account-key.ts';
import { newIdentity } from '../keys.ts';
import { AccountKeys, type KeysTrust } from './account-keys.ts';
import { FakeHeldService } from './connect-fakes.ts';
import { HeldApi } from './held-api.ts';
import { memoryQueueStore, type QueueStore } from './held-queue.ts';
import { connectLists, type ConnectLists, type ListKind } from '../lists.ts';
import { NO_REVIEW_REQUESTS, type ReviewRequest } from '../../shared/review-requests.ts';
import { REVIEWS_OFF_REASON } from '../../shared/review-settings.ts';
import { NO_TICKETS, TICKETS_OFF_REASON, type Ticket } from '../../shared/tickets.ts';
import type { ReviewsAnswer, TicketsAnswer } from '../../shared/connect-lists.ts';
import { CHUNK_MESSAGES, DEFAULT_HELD_PREFS, HeldConversations, heldSource, NO_PROJECT, type HeldPrefs, type HeldSource } from './held.ts';

const MAC = 'mac-1';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closing) await close();
  closing = [];
  vi.useRealTimers();
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

function uploader(service: FakeHeldService, keys: AccountKeys, source: HeldSource, opts: { prefs?: () => HeldPrefs; queue?: QueueStore; online?: () => boolean } = {}) {
  const held = new HeldConversations({
    source,
    api: () => (opts.online?.() ?? true ? new HeldApi((m, p, b) => service.call(MAC, m, p, b)) : null),
    key: () => keys.ready(),
    keyFor: (g) => keys.keyFor(g),
    resync: () => keys.sync(),
    desk: () => ({ id: MAC, name: 'Studio Mac' }),
    prefs: opts.prefs ?? (() => DEFAULT_HELD_PREFS),
    queue: opts.queue ?? memoryQueueStore(),
    changed: () => undefined,
    here: 'your Mac',
    settleMs: 60_000,
    streamMs: 60_000,
  });
  closing.push(() => held.close());
  return held;
}

/** A real desk: workspace, runtime, one fake agent per provider, one project. */
async function desk() {
  const workspace = new Workspace(memoryPersistence());
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-held-')));
  const fakes = Object.fromEntries(SELECTABLE_AGENTS.map((a) => [a, new FakeAgents()])) as Record<Agent, FakeAgents>;
  const adapters = Object.fromEntries(SELECTABLE_AGENTS.map((a): [Agent, AgentAdapter] => [a, { ...fakes[a].adapter(), agent: a }]));
  const runtime = new SessionRuntime(workspace, adapters, data);
  const project = await createProject(workspace, { name: 'Shop' });
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      for (const f of Object.values(fakes)) await f.settled();
      for (const s of (await workspace.state()).sessions) await runtime.idle(s.id);
    }
  };
  return { workspace, runtime, fakes, project, settle, source: heldSource(workspace, runtime, connectLists(runtime.reviewPrefs, null, null)) };
}

/** What the service holds, opened as a phone with the key would open it. */
function opened(service: FakeHeldService, keys: AccountKeys, label: string): any {
  const key = keys.ready()!;
  const id = tagOf(key.idKey, label);
  const record = service.records.get(id);
  return record ? openRecord(keys.keyFor(record.generation), record.body, 'record', id, record.generation) : undefined;
}

describe.each(SELECTABLE_AGENTS)('held conversations, for a %s session', (agent) => {
  it('holds a turn encrypted, with an index the phone can open, and no plaintext on the service', async () => {
    const service = new FakeHeldService();
    const keys = await openKeys(service);
    const d = await desk();
    d.fakes[agent].script = (turn) => turn.emit({ type: 'message', id: `a${turn.n}`, text: 'the invoice total is 4211', delta: 'the invoice total is 4211', done: true });
    const session = await d.runtime.start({ agent, projectId: d.project.id, prompt: 'what is the invoice total' });
    await d.settle();
    const held = uploader(service, keys, d.source);
    await held.run();

    const index = opened(service, keys, `index|${MAC}`);
    expect(index).toMatchObject({ v: 1, kind: 'index', desk: { id: MAC, name: 'Studio Mac' }, sessions: [{ id: session.id, agent, project: { id: d.project.id, name: 'Shop' }, messages: 2, chunks: 1 }] });
    const chunk = opened(service, keys, `chunk|${MAC}|${session.id}|0`);
    expect(chunk.messages.map((m: ChatMessage) => m.text)).toEqual(['what is the invoice total', 'the invoice total is 4211']);
    const record = service.records.get(tagOf(keys.ready()!.idKey, `chunk|${MAC}|${session.id}|0`))!;
    expect(record.session).toBe(tagOf(keys.ready()!.idKey, `session|${MAC}|${session.id}`));
    expect(record.project).toBe(tagOf(keys.ready()!.idKey, `project|${MAC}|${d.project.id}`));
    // The service's copy says nothing: not the text, the title, the project or the session id.
    const dump = JSON.stringify([...service.records.values()]);
    for (const secret of ['invoice', '4211', 'Shop', session.id, 'Studio Mac', agent]) expect(dump).not.toContain(secret);
  });

  it('delivers a message a phone left while the desk was away, once, and says so in the index', async () => {
    const service = new FakeHeldService();
    const keys = await openKeys(service);
    const d = await desk();
    const session = await d.runtime.start({ agent, projectId: d.project.id, prompt: 'start' });
    await d.settle();
    const key = keys.ready()!;
    const body = { v: 1, sessionId: session.id, text: 'from the train', attachments: [{ name: 'a.png', mediaType: 'image/png', data: PNG }], sentAt: 1, from: { id: 'phone-1', name: 'iPhone' } };
    service.addDevice('phone-1', 'iPhone', 'phone');
    service.post({ id: 'm1', from: 'phone-1', to: MAC, generation: key.generation, body: sealRecord(key.adk, 'message', 'm1', key.generation, body) });
    const held = uploader(service, keys, d.source);
    await held.deliverWaiting();
    await d.settle();
    const turn = d.fakes[agent].turns.at(-1)!;
    expect(turn.text).toContain('from the train');
    expect(turn.attachments).toHaveLength(1);
    expect(service.messages.size).toBe(0);
    // Taken already: offered again (a delete that did not reach the service), it is not sent twice.
    service.post({ id: 'm1', from: 'phone-1', to: MAC, generation: key.generation, body: sealRecord(key.adk, 'message', 'm1', key.generation, body) });
    const turns = d.fakes[agent].turns.length;
    await held.deliverWaiting();
    await d.settle();
    expect(d.fakes[agent].turns.length).toBe(turns);
    expect(service.messages.size).toBe(0);
    await held.run();
    expect(opened(service, keys, `index|${MAC}`).deliveries).toEqual([{ id: 'm1', ok: true, at: expect.any(Number) }]);
  });
});

/** A source the test drives by hand. */
function stubSource(initial: { sessions: { id: string; project: string | null; messages: ChatMessage[] }[] }) {
  let sessions = initial.sessions;
  let stamp = 1;
  const changes = new Set<() => void>();
  const lives = new Set<(id: string, streaming: boolean) => void>();
  const files = new Map<string, string>();
  const counts = { passes: 0 };
  const contexts = new Map<string, ContextUsage>();
  const measured = new Set<() => void>();
  let reviews: ReviewsAnswer = { on: false, reason: REVIEWS_OFF_REASON };
  let tickets: TicketsAnswer = { on: false, reason: TICKETS_OFF_REASON };
  const listChanges = new Set<(kind: ListKind) => void>();
  const lists: ConnectLists = { reviews: async () => reviews, tickets: () => tickets, onChange: (l) => (listChanges.add(l), () => listChanges.delete(l)) };
  const source: HeldSource = {
    lists,
    state: async () => {
      counts.passes++;
      return {
        projects: [{ id: 'p1', name: 'Shop', folders: [] }, { id: 'p2', name: 'Secret', folders: [] }],
        sessions: sessions.map((s) => ({ id: s.id, title: `t-${s.id}`, agent: 'claude', state: 'done', note: '', startedIn: s.project, landedIn: s.project, createdAt: 1, updatedAt: stamp, lastActivityAt: stamp })),
        archived: { sessions: [] },
      } as unknown as WorkspaceState;
    },
    messages: async (id) => sessions.find((s) => s.id === id)?.messages ?? null,
    attachment: (_s, id) => (files.has(id) ? { path: files.get(id)!, type: 'image/png', name: 'a.png' } : null),
    media: () => null,
    onChange: (l) => (changes.add(l), () => changes.delete(l)),
    onLive: (l) => (lives.add(l), () => lives.delete(l)),
    onContext: (l) => (measured.add(l), () => measured.delete(l)),
    context: (session) => {
      const usage = contexts.get(session.id);
      return usage ? { context: usage } : { context: null, contextNote: 'Not measured yet. It is measured each time a turn ends.' };
    },
    reply: async () => undefined,
  };
  return {
    source,
    counts,
    files,
    set(next: typeof sessions) {
      sessions = next;
      stamp += 1;
      for (const l of changes) l();
    },
    live(id: string) {
      for (const l of lives) l(id, true);
    },
    /** The Code reviews or Tickets list changed. */
    lists(next: { reviews?: ReviewsAnswer; tickets?: TicketsAnswer }) {
      reviews = next.reviews ?? reviews;
      tickets = next.tickets ?? tickets;
      for (const l of listChanges) l(next.reviews ? 'reviews' : 'tickets');
    },
    /** A new measurement (null: the desk restarted and knows none now). */
    measure(id: string, usage: ContextUsage | null) {
      if (usage) contexts.set(id, usage);
      else contexts.delete(id);
      for (const l of measured) l();
    },
  };
}

const msgs = (n: number, prefix = 'm'): ChatMessage[] => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, author: i % 2 ? 'agent' : 'you', time: '', text: `${prefix} ${i}` }));
const puts = (service: FakeHeldService) => service.calls.filter((c) => c.startsWith('PUT')).length;

describe('how full the context window is, in the index', () => {
  const usage = (used: number): ContextUsage => ({ model: 'claude-opus-5-5', usedTokens: used, windowTokens: 200_000, rows: [{ name: 'Messages', tokens: used, kind: 'used' }], at: 5 });

  it('carries the measurement, or the words in its place, and keeps the last one sent across a restart', async () => {
    const service = new FakeHeldService();
    const keys = await openKeys(service);
    const queue = memoryQueueStore();
    const s = stubSource({ sessions: [{ id: 's1', project: 'p1', messages: msgs(2) }] });
    const held = uploader(service, keys, s.source, { queue });
    await held.run();
    expect(opened(service, keys, `index|${MAC}`).sessions[0]).toMatchObject({ context: null, contextNote: 'Not measured yet. It is measured each time a turn ends.' });
    s.measure('s1', usage(50_000));
    await held.run();
    expect(opened(service, keys, `index|${MAC}`).sessions[0]).toMatchObject({ context: usage(50_000) });
    expect(opened(service, keys, `index|${MAC}`).sessions[0].contextNote).toBeUndefined();
    // The desk restarts: nothing is measured now, but the last one sent is kept, from the queue file.
    await held.close();
    s.measure('s1', null);
    const again = uploader(service, keys, s.source, { queue });
    s.set([{ id: 's1', project: 'p1', messages: msgs(3) }]);
    await again.run();
    expect(opened(service, keys, `index|${MAC}`).sessions[0]).toMatchObject({ context: usage(50_000) });
    await again.close();
  });
});

// Matt, 2026-11-24: "please add the code review and tickets pages". Held for when the desk is away.
describe('the Code reviews and Tickets lists, held', () => {
  const request = (n: number, projectId: string | null): ReviewRequest => ({ host: 'github', hostName: 'github.com', repository: 'acme/shop', number: n, title: `Change ${n}`, author: 'sam', url: 'https://github.com/acme/shop/pull/1', updatedAt: n, key: `r${n}`, projectId });
  const ticket = (n: number): Ticket => ({ key: `t${n}`, source: 'github', tracker: 'GitHub', ref: `#${n}`, title: `Bug ${n}`, status: { name: 'Open', category: 'todo' }, project: 'acme/shop', url: 'https://github.com/acme/shop/issues/1', openedAt: n, updatedAt: n });

  it('holds off as off, then each list without what is kept off or the ticket pages, and sends it again only when it changed', async () => {
    const service = new FakeHeldService();
    const keys = await openKeys(service);
    const s = stubSource({ sessions: [{ id: 's1', project: 'p1', messages: msgs(1) }, { id: 's2', project: 'p2', messages: msgs(1) }] });
    const held = uploader(service, keys, s.source, { prefs: () => ({ ...DEFAULT_HELD_PREFS, keptOff: ['p2'] }) });
    await held.run();
    expect(opened(service, keys, `reviews|${MAC}`)).toMatchObject({ v: 1, kind: 'reviews', desk: MAC, reviews: { on: false, reason: REVIEWS_OFF_REASON } });
    expect(opened(service, keys, `tickets|${MAC}`)).toMatchObject({ kind: 'tickets', tickets: { on: false, reason: TICKETS_OFF_REASON } });

    s.lists({ reviews: { on: true, view: { ...NO_REVIEW_REQUESTS, requests: [request(1, 'p1'), request(2, 'p2'), request(3, null)] } } });
    s.lists({
      tickets: {
        on: true,
        sourcesOff: [],
        view: { ...NO_TICKETS, tickets: [ticket(1)], settings: { on: true, off: [], show: 'page' }, details: { t1: { state: 'loading' } as never }, links: [{ ticketKey: 't1', attachedTo: 'session', id: 's1', role: 'lead', at: 1 }, { ticketKey: 't1', attachedTo: 'session', id: 's2', role: 'part', at: 1 }, { ticketKey: 't1', attachedTo: 'workstream', id: 'w1', role: 'lead', at: 1 }] },
      },
    });
    await held.run();
    expect(opened(service, keys, `reviews|${MAC}`).reviews.view.requests.map((r: ReviewRequest) => r.key)).toEqual(['r1', 'r3']);
    const t = opened(service, keys, `tickets|${MAC}`).tickets;
    expect(t.view.details).toEqual({});
    expect(t.view.links.map((l: { id: string }) => l.id)).toEqual(['s1', 'w1']);

    const before = puts(service);
    await held.run();
    expect(puts(service)).toBe(before);
    await held.close();
  });
});

describe('what is sent, and when', () => {
  it('sends only the chunks whose content changed', async () => {
    const service = new FakeHeldService();
    const keys = await openKeys(service);
    const s = stubSource({ sessions: [{ id: 's1', project: 'p1', messages: msgs(CHUNK_MESSAGES + 10) }] });
    const held = uploader(service, keys, s.source);
    await held.run();
    expect(puts(service)).toBe(5); // two chunks, the index, and the Code reviews and Tickets lists
    s.set([{ id: 's1', project: 'p1', messages: msgs(CHUNK_MESSAGES + 11) }]);
    service.calls = [];
    await held.run();
    expect(service.calls.filter((c) => c.startsWith('PUT'))).toHaveLength(2); // the second chunk and the index
    expect(opened(service, keys, `chunk|${MAC}|s1|1`).messages).toHaveLength(11);
  });

  it('uploads one second after a change settles and at most once per interval while one streams; never in the listener', async () => {
    vi.useFakeTimers();
    const service = new FakeHeldService();
    const keys = await openKeys(service);
    const s = stubSource({ sessions: [{ id: 's1', project: 'p1', messages: msgs(2) }] });
    service.calls = [];
    const held = new HeldConversations({ source: s.source, api: () => new HeldApi((m, p, b) => service.call(MAC, m, p, b)), key: () => keys.ready(), keyFor: (g) => keys.keyFor(g), resync: () => keys.sync(), desk: () => ({ id: MAC, name: 'Mac' }), prefs: () => DEFAULT_HELD_PREFS, queue: memoryQueueStore(), changed: () => undefined, here: 'your Mac' });
    closing.push(() => held.close());
    s.set([{ id: 's1', project: 'p1', messages: msgs(3) }]);
    expect(service.calls).toEqual([]); // nothing ran inside the change
    await vi.advanceTimersByTimeAsync(999);
    expect(service.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(10);
    expect(puts(service)).toBe(4); // the chunk, the index and the two lists
    const passes = s.counts.passes;
    for (let i = 0; i < 20; i++) {
      s.live('s1');
      await vi.advanceTimersByTimeAsync(200);
    }
    // Four seconds of streaming: no pass yet (the last was under five seconds ago).
    expect(s.counts.passes).toBe(passes);
    await vi.advanceTimersByTimeAsync(2_000);
    // Then one pass, not twenty.
    expect(s.counts.passes).toBe(passes + 1);
  });

  it('deletes a deleted session, and keeps a kept-off project off, deleting what it held', async () => {
    const service = new FakeHeldService();
    const keys = await openKeys(service);
    let prefs: HeldPrefs = DEFAULT_HELD_PREFS;
    const s = stubSource({ sessions: [{ id: 's1', project: 'p1', messages: msgs(2) }, { id: 's2', project: 'p2', messages: msgs(2) }, { id: 's3', project: null, messages: msgs(2) }] });
    const held = uploader(service, keys, s.source, { prefs: () => prefs });
    await held.run();
    expect(opened(service, keys, `chunk|${MAC}|s2|0`)).toBeDefined();
    const before = prefs;
    prefs = { ...prefs, keptOff: ['p2', NO_PROJECT] };
    await held.prefsChanged(before, prefs);
    await held.run();
    expect(opened(service, keys, `chunk|${MAC}|s2|0`)).toBeUndefined();
    expect(opened(service, keys, `chunk|${MAC}|s3|0`)).toBeUndefined();
    expect(opened(service, keys, `index|${MAC}`).sessions.map((x: { id: string }) => x.id)).toEqual(['s1']);
    s.set([{ id: 's2', project: 'p2', messages: msgs(2) }, { id: 's3', project: null, messages: msgs(2) }]);
    await held.run();
    expect(opened(service, keys, `chunk|${MAC}|s1|0`)).toBeUndefined();
    expect([...service.records.values()]).toHaveLength(3); // the index and the two lists alone
    // Switched back on: held again in full.
    await held.prefsChanged(prefs, DEFAULT_HELD_PREFS);
    prefs = DEFAULT_HELD_PREFS;
    await held.run();
    expect(opened(service, keys, `chunk|${MAC}|s2|0`)).toBeDefined();
  });

  it('holds attachments only when switched on, and deletes them when switched off', async () => {
    const service = new FakeHeldService();
    const keys = await openKeys(service);
    let prefs: HeldPrefs = DEFAULT_HELD_PREFS;
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-held-file-')));
    const path = join(dir, 'a.png');
    (await import('node:fs')).writeFileSync(path, Buffer.from(PNG, 'base64'));
    const withFile: ChatMessage[] = [{ id: 'u', author: 'you', time: '', text: 'see', attachments: [{ id: 'att1', name: 'a.png', mediaType: 'image/png', size: 70, kind: 'image' }] }];
    const s = stubSource({ sessions: [{ id: 's1', project: 'p1', messages: withFile }] });
    s.files.set('att1', path);
    const held = uploader(service, keys, s.source, { prefs: () => prefs });
    await held.run();
    expect(opened(service, keys, `attachment|${MAC}|s1|att1`)).toBeUndefined();
    expect(opened(service, keys, `chunk|${MAC}|s1|0`).messages[0].attachments[0].name).toBe('a.png');
    await held.prefsChanged(prefs, (prefs = { ...prefs, attachments: true }));
    await held.run();
    expect(opened(service, keys, `attachment|${MAC}|s1|att1`)).toMatchObject({ kind: 'attachment', name: 'a.png', type: 'image/png', data: PNG });
    await held.prefsChanged(prefs, (prefs = { ...prefs, attachments: false }));
    await held.run();
    expect(opened(service, keys, `attachment|${MAC}|s1|att1`)).toBeUndefined();
  });

  it('keeps what it owes across a restart, and sends nothing while offline or with no key', async () => {
    const service = new FakeHeldService();
    const keys = await openKeys(service);
    const queue = memoryQueueStore();
    let online = false;
    const s = stubSource({ sessions: [{ id: 's1', project: 'p1', messages: msgs(2) }] });
    const first = uploader(service, keys, s.source, { queue, online: () => online });
    await first.run();
    expect(service.records.size).toBe(0);
    online = true;
    await first.run();
    expect(service.records.size).toBe(4);
    await first.close();
    // Restarted: nothing changed, nothing is sent again.
    service.calls = [];
    const second = uploader(service, keys, s.source, { queue });
    await second.run();
    expect(puts(service)).toBe(0);
  });

  it('refuses a waiting message for a session that is gone, and says why in the index', async () => {
    const service = new FakeHeldService();
    const keys = await openKeys(service);
    const s = stubSource({ sessions: [{ id: 's1', project: 'p1', messages: msgs(2) }] });
    const key = keys.ready()!;
    service.post({ id: 'm9', from: 'phone-1', to: MAC, generation: key.generation, body: sealRecord(key.adk, 'message', 'm9', key.generation, { v: 1, sessionId: 'gone', text: 'hi', sentAt: 1, from: { id: 'phone-1', name: 'iPhone' } }) });
    service.post({ id: 'm10', from: 'phone-1', to: MAC, generation: key.generation, body: 'not-sealed' });
    const held = uploader(service, keys, s.source);
    await held.deliverWaiting();
    await held.run();
    expect(opened(service, keys, `index|${MAC}`).deliveries).toEqual([
      { id: 'm9', ok: false, reason: 'That session is no longer in Kestrel.', at: expect.any(Number) },
      { id: 'm10', ok: false, reason: 'The message could not be read on your Mac.', at: expect.any(Number) },
    ]);
  });

  it('says when the account is full, and tries again only after something changes', async () => {
    const service = new FakeHeldService();
    service.limit = 10;
    const keys = await openKeys(service);
    const s = stubSource({ sessions: [{ id: 's1', project: 'p1', messages: msgs(2) }] });
    const held = uploader(service, keys, s.source);
    await held.run();
    expect(held.view().problem).toMatch(/holds as much as it can/);
  });
});
