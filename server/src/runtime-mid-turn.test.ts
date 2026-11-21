// A message the user writes while the agent works goes into the running turn at once (0.0.18), with
// an agent that takes messages mid-turn (FakeAgents.midTurn = 'accept'). It shows in the conversation
// as sent, in order, inside the turn; the agent's `picked-up` marks it read; one the agent never read
// before its run ended is held again, never lost and never sent twice. The fallbacks (a card waiting,
// a settings change, a slash command, the agent refusing) hold it with why. Turns are held open and
// ended by hand, so nothing here depends on timing.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InputRequest } from './agents/types.ts';
import type { LivePatch } from './model.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { SessionRuntime } from './runtime.ts';
import { turnFooters } from './shared/turns.ts';
import { FakeAgents, type MidTurnMode } from './test-agent.ts';
import { Workspace } from './workspace.ts';

const CARD: InputRequest = { id: 'r1', kind: 'approval', title: 'Run x', detail: 'x', tool: 'Bash', options: [{ id: 'allow', label: 'Allow', role: 'allow' }] };

async function setup(mode: MidTurnMode = 'accept') {
  const db = memoryPersistence();
  const workspace = new Workspace(db);
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-midturn-')));
  const agents = new FakeAgents();
  agents.hold = true;
  agents.midTurn = mode;
  let clock = 1_000;
  const runtime = new SessionRuntime(workspace, { claude: agents.adapter() }, data, { now: () => (clock += 1_000) });
  const patches: LivePatch[] = [];
  runtime.onLive((_id, patch) => patches.push(patch));
  const session = await runtime.start({ agent: 'claude', projectId: null, prompt: 'first task' });
  await agents.settled();
  const messages = () => runtime.overlay(session.id)!.messages;
  const mine = () => messages().filter((m) => m.author === 'you').map((m) => [m.text, m.midTurn ?? 'starts']);
  const held = () => runtime.overlay(session.id)!.queue!.items.map((m) => [m.text, m.why]);
  const settle = async () => {
    await runtime.idle(session.id);
    await agents.settled();
  };
  return { db, data, workspace, agents, runtime, session, patches, messages, mine, held, settle };
}

describe('a message written while the agent works', () => {
  it('goes into the running turn at once, shows as sent in order, and is not queued', async () => {
    const { runtime, session, agents, mine, held, patches } = await setup();
    await expect(runtime.reply(session.id, 'also do this')).resolves.toBe('delivered');
    await expect(runtime.reply(session.id, 'and this')).resolves.toBe('delivered');
    expect(agents.turns).toHaveLength(1);
    expect(agents.turns[0]!.midTurn.map((m) => m.text)).toEqual(['also do this', 'and this']);
    expect(held()).toEqual([]);
    expect(mine()).toEqual([
      ['first task', 'starts'],
      ['also do this', 'sent'],
      ['and this', 'sent'],
    ]);
    // The id the agent got is the message's own, and watchers saw it at once.
    expect(agents.turns[0]!.midTurn[0]!.id).toBe(runtime.overlay(session.id)!.messages.find((m) => m.text === 'also do this')!.id);
    expect(patches.some((p) => p.messages?.some((m) => m.text === 'also do this' && m.midTurn === 'sent'))).toBe(true);
  });

  it('is marked read when the agent says it read it', async () => {
    const { runtime, session, agents, mine } = await setup();
    await runtime.reply(session.id, 'one');
    await runtime.reply(session.id, 'two');
    agents.turns[0]!.pickUp(agents.turns[0]!.midTurn[0]!.id);
    expect(mine().slice(1)).toEqual([
      ['one', 'read'],
      ['two', 'sent'],
    ]);
  });

  it('is part of the turn it went into: one turn, one footer timing all of it, one fork point', async () => {
    const { runtime, session, agents, messages, settle } = await setup();
    agents.turns[0]!.emit({ type: 'message', id: 'a1', text: 'working on it', delta: 'working on it', done: true });
    await runtime.reply(session.id, 'also this');
    agents.turns[0]!.pickUp();
    agents.turns[0]!.emit({ type: 'message', id: 'a2', text: 'done, and did that too', delta: '', done: true });
    agents.turns[0]!.emit({ type: 'turn-point', point: 'p1' });
    agents.turns[0]!.done();
    await settle();
    const footers = turnFooters(messages(), false);
    expect(footers).toHaveLength(1);
    expect(footers[0]!.at).toBe(messages().length - 1);
    expect(footers[0]!.markdown).toBe('working on it\n\ndone, and did that too');
    const first = messages().find((m) => m.text === 'first task')!;
    expect(first.forkPoint).toBe('p1');
    expect(first.turnEndedAt).toBeDefined();
    expect(messages().find((m) => m.text === 'also this')!.turnEndedAt).toBeUndefined();
    // Nothing was left to send: no second turn.
    expect(agents.turns).toHaveLength(1);
  });

  it('is held when the agent cannot take it now, and sent once as the next turn', async () => {
    const { runtime, session, agents, mine, held, settle } = await setup('refuse');
    await expect(runtime.reply(session.id, 'later')).resolves.toBe('queued');
    expect(held()).toEqual([['later', 'busy']]);
    expect(mine()).toEqual([['first task', 'starts']]);
    agents.turns[0]!.done();
    await settle();
    expect(agents.turns.map((t) => t.text)).toEqual(['first task', 'later']);
    expect(held()).toEqual([]);
    expect(mine()).toEqual([
      ['first task', 'starts'],
      ['later', 'starts'],
    ]);
  });

  it('waits behind a held message, so the order the user wrote stays', async () => {
    const { runtime, session, agents, held } = await setup();
    await runtime.reply(session.id, 'switch model first', { model: 'other' });
    await runtime.reply(session.id, 'then this');
    expect(held()).toEqual([
      ['switch model first', 'settings'],
      ['then this', 'behind'],
    ]);
    expect(agents.turns[0]!.midTurn).toEqual([]);
  });

  it('holds a settings change and a slash command for the next turn, saying why', async () => {
    const { runtime, session, agents, held, settle } = await setup();
    await runtime.reply(session.id, 'think harder', { effort: 'high' });
    expect(held()).toEqual([['think harder', 'settings']]);
    agents.turns[0]!.done();
    await settle();
    expect(runtime.overlay(session.id)!.settings!.effort).toBe('high');
    expect(agents.turns.at(-1)!.text).toBe('think harder');
    await runtime.reply(session.id, '/compact');
    expect(held()).toEqual([['/compact', 'command']]);
  });

  it('a change equal to the current settings is no change: it goes in mid-turn', async () => {
    const { runtime, session } = await setup();
    await expect(runtime.reply(session.id, 'same as before', { permission: 'ask' })).resolves.toBe('delivered');
  });

  it('waits while a card wants an answer, and goes into the turn once it is answered', async () => {
    const { runtime, session, agents, held, mine } = await setup();
    agents.turns[0]!.emit({ type: 'needs-input', request: CARD });
    await runtime.idle(session.id);
    await expect(runtime.reply(session.id, 'while you ask')).resolves.toBe('queued');
    expect(held()).toEqual([['while you ask', 'card']]);
    await runtime.answer(session.id, 'r1', { optionId: 'allow' });
    expect(held()).toEqual([]);
    expect(agents.turns[0]!.midTurn.map((m) => m.text)).toEqual(['while you ask']);
    expect(mine().at(-1)).toEqual(['while you ask', 'sent']);
  });

  it('after Stop, an unread message comes out of the conversation and is held for the user', async () => {
    const { runtime, session, agents, mine, held, patches, settle } = await setup();
    await runtime.reply(session.id, 'read this');
    await runtime.reply(session.id, 'not this');
    agents.turns[0]!.pickUp(agents.turns[0]!.midTurn[0]!.id);
    const unreadId = agents.turns[0]!.midTurn[1]!.id;
    await runtime.stop(session.id);
    await settle();
    // The one it read stays as read; the one it never read is held, and nothing went by itself.
    expect(mine()).toEqual([
      ['first task', 'starts'],
      ['read this', 'read'],
    ]);
    expect(held()).toEqual([['not this', 'unread']]);
    expect(runtime.overlay(session.id)!.queue!.held).toBe(true);
    expect(patches.some((p) => p.removedMessages?.includes(unreadId))).toBe(true);
    expect(agents.turns).toHaveLength(1);
    // The user sends it: exactly once.
    await runtime.sendQueued(session.id);
    await settle();
    expect(agents.turns.map((t) => t.text)).toEqual(['first task', 'not this']);
    expect(mine().filter(([text]) => text === 'not this')).toEqual([['not this', 'starts']]);
  });

  it('a message the agent took and never read before its run ended normally is the next turn, once', async () => {
    const { runtime, session, agents, mine, settle } = await setup();
    await runtime.reply(session.id, 'too late');
    agents.turns[0]!.done();
    await settle();
    expect(agents.turns.map((t) => t.text)).toEqual(['first task', 'too late']);
    expect(mine()).toEqual([
      ['first task', 'starts'],
      ['too late', 'starts'],
    ]);
  });

  it('an unread message survives a server restart, held', async () => {
    const { db, data, runtime, session } = await setup();
    await runtime.reply(session.id, 'keep me');
    await runtime.shutdown(); // stops the turn: the agent lists it unread, and everything is stored

    const agents2 = new FakeAgents();
    const runtime2 = new SessionRuntime(new Workspace(db), { claude: agents2.adapter() }, data);
    await runtime2.recoverAfterRestart();
    const snap = (await runtime2.snapshot(session.id))!;
    expect(snap.queue).toMatchObject({ held: true, items: [{ text: 'keep me', why: 'unread' }] });
    expect(snap.messages!.some((m) => m.text === 'keep me')).toBe(false);
    await runtime2.sendQueued(session.id);
    await agents2.settled();
    expect(agents2.turns.at(-1)!.text).toBe('keep me');
  });

  it('a read message stays in the conversation, as read, across a restart', async () => {
    const { db, data, runtime, session, agents } = await setup();
    await runtime.reply(session.id, 'seen');
    agents.turns[0]!.pickUp();
    await runtime.shutdown();
    const runtime2 = new SessionRuntime(new Workspace(db), { claude: new FakeAgents().adapter() }, data);
    await runtime2.recoverAfterRestart();
    const snap = (await runtime2.snapshot(session.id))!;
    expect(snap.messages!.find((m) => m.text === 'seen')!.midTurn).toBe('read');
    expect(snap.queue?.items ?? []).toEqual([]);
  });

  it("another session's message (ask_session) still waits for the turn to end", async () => {
    const { runtime, session, agents, held, settle } = await setup();
    await expect(runtime.reply(session.id, '[Kestrel] please rename foo', {}, { fromAgent: true })).resolves.toBe('queued');
    await expect(runtime.reply(session.id, 'from the user')).resolves.toBe('delivered');
    expect(agents.turns[0]!.midTurn.map((m) => m.text)).toEqual(['from the user']);
    expect(held()).toEqual([['[Kestrel] please rename foo', undefined]]);
    agents.turns[0]!.pickUp();
    agents.turns[0]!.done();
    await settle();
    expect(agents.turns.at(-1)!.text).toBe('[Kestrel] please rename foo');
  });

  it('news from other sessions still waits for the turn to end', async () => {
    const { runtime, session, agents, settle } = await setup();
    await runtime.queueNews(session, '[Kestrel] a child finished');
    await runtime.reply(session.id, 'mine');
    expect(agents.turns[0]!.midTurn.map((m) => m.text)).toEqual(['mine']);
    agents.turns[0]!.pickUp();
    agents.turns[0]!.done();
    await settle();
    expect(agents.turns.at(-1)!.text).toBe('[Kestrel] a child finished');
  });

  it('does not make the turn the user\'s: who started it stays who started it', async () => {
    const { runtime, session, agents } = await setup();
    const rec = runtime.recordOf(session.id)!;
    rec.turnByUser = false; // as for a delegated brief
    await runtime.reply(session.id, 'a word in the middle');
    expect(agents.turns[0]!.midTurn).toHaveLength(1);
    expect(rec.turnByUser).toBe(false);
  });

  it('with an agent that takes nothing mid-turn (no sendNow), everything is held as before', async () => {
    const { runtime, session, held } = await setup('absent');
    await expect(runtime.reply(session.id, 'x')).resolves.toBe('queued');
    expect(held()).toEqual([['x', 'busy']]);
  });
});
