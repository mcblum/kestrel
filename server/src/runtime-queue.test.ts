// Messages written while the agent works, with an agent that cannot take them mid-turn (no
// `sendNow`, as an adapter written before 0.0.18): held on the server, sent as the next turn when the
// running one ends normally, held after a stop or a failure. runtime-mid-turn.test.ts has the agent
// that takes them at once. Turns are held open by the scripted agent (FakeAgents.hold) and ended by
// hand, so nothing here depends on timing.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LivePatch } from './model.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { SessionRuntime } from './runtime.ts';
import { FakeAgents } from './test-agent.ts';
import { Workspace } from './workspace.ts';

async function setup() {
  const db = memoryPersistence();
  const workspace = new Workspace(db);
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-queue-')));
  const agents = new FakeAgents();
  agents.hold = true;
  const runtime = new SessionRuntime(workspace, { claude: agents.adapter() }, data);
  const patches: LivePatch[] = [];
  runtime.onLive((_id, patch) => patches.push(patch));
  const session = await runtime.start({ agent: 'claude', projectId: null, prompt: 'first task' });
  await agents.settled();
  const userTexts = () => runtime.overlay(session.id)!.messages.filter((m) => m.author === 'you' && !m.notice).map((m) => m.text);
  const queued = () => runtime.overlay(session.id)!.queue!.items.map((m) => m.text);
  /** End the turn that is running now, normally, and wait for everything it sets off. */
  const finishTurn = async () => {
    agents.turns.at(-1)!.done();
    await runtime.idle(session.id);
    await agents.settled();
  };
  return { db, workspace, data, agents, runtime, session, patches, userTexts, queued, finishTurn };
}

describe('queueing a message while the agent works', () => {
  it('queues instead of refusing, outside the transcript, and tells watchers', async () => {
    const { runtime, session, patches, userTexts, queued } = await setup();
    await expect(runtime.reply(session.id, 'also do this')).resolves.toBe('queued');
    expect(queued()).toEqual(['also do this']);
    expect(userTexts()).toEqual(['first task']);
    expect(patches.at(-1)?.queue?.items.map((m) => m.text)).toEqual(['also do this']);
    // A reloaded window gets it in the snapshot.
    expect((await runtime.snapshot(session.id))!.queue!.items).toHaveLength(1);
  });

  it('sends everything queued, in order, as one turn when the running turn ends', async () => {
    const { runtime, session, agents, userTexts, queued, finishTurn } = await setup();
    await runtime.reply(session.id, 'one');
    await runtime.reply(session.id, 'two');
    await runtime.reply(session.id, 'three');
    expect(agents.turns).toHaveLength(1);
    await finishTurn();
    expect(agents.turns).toHaveLength(2);
    expect(agents.turns[1]!.text).toBe('one\n\ntwo\n\nthree');
    expect(queued()).toEqual([]);
    expect(userTexts()).toEqual(['first task', 'one', 'two', 'three']);
  });

  it('drops a removed message and sends the rest', async () => {
    const { runtime, session, agents, queued, finishTurn } = await setup();
    await runtime.reply(session.id, 'keep');
    await runtime.reply(session.id, 'drop');
    const drop = runtime.overlay(session.id)!.queue!.items.find((m) => m.text === 'drop')!;
    await runtime.removeQueued(session.id, drop.id);
    expect(queued()).toEqual(['keep']);
    await expect(runtime.removeQueued(session.id, drop.id)).rejects.toThrow(/no longer queued/);
    await finishTurn();
    expect(agents.turns[1]!.text).toBe('keep');
  });

  it('holds the queue after a stop, and sends it when the user says so', async () => {
    const { runtime, session, agents, queued, userTexts } = await setup();
    await runtime.reply(session.id, 'later');
    await runtime.stop(session.id);
    await runtime.idle(session.id);
    await agents.settled();
    expect(agents.turns).toHaveLength(1);
    expect(runtime.overlay(session.id)!.queue).toMatchObject({ held: true });
    expect(queued()).toEqual(['later']);
    expect(userTexts()).toEqual(['first task']);

    await runtime.sendQueued(session.id);
    await agents.settled();
    expect(agents.turns[1]!.text).toBe('later');
    expect(queued()).toEqual([]);
  });

  it('holds the queue after a failed turn', async () => {
    const { runtime, session, agents, queued } = await setup();
    await runtime.reply(session.id, 'after');
    agents.turns[0]!.emit({ type: 'failed', reason: 'boom', kind: 'other' });
    await runtime.idle(session.id);
    await agents.settled();
    expect(agents.turns).toHaveLength(1);
    expect(runtime.overlay(session.id)!.queue).toMatchObject({ held: true });
    expect(queued()).toEqual(['after']);
  });

  it('sends a held queue together with the next message written, the new one last', async () => {
    const { runtime, session, agents, queued } = await setup();
    await runtime.reply(session.id, 'queued earlier');
    await runtime.stop(session.id);
    await runtime.idle(session.id);
    await expect(runtime.reply(session.id, 'new')).resolves.toBe('sent');
    await agents.settled();
    expect(agents.turns[1]!.text).toBe('queued earlier\n\nnew');
    expect(queued()).toEqual([]);
  });

  it('refuses "send now" while the turn still runs, and when nothing is queued', async () => {
    const { runtime, session, finishTurn } = await setup();
    await expect(runtime.sendQueued(session.id)).rejects.toThrow(/Nothing is queued/);
    await runtime.reply(session.id, 'x');
    await expect(runtime.sendQueued(session.id)).rejects.toThrow(/still working/);
    await finishTurn();
  });

  it('applies a model or permission change with the queued turn, not the running one', async () => {
    const { runtime, session, agents, finishTurn } = await setup();
    await runtime.reply(session.id, 'plan it', { permission: 'plan' });
    expect(runtime.overlay(session.id)!.settings!.permission).toBe('ask');
    expect(agents.resumes).toHaveLength(0);
    await finishTurn();
    // The handle is rebuilt with the new level for the queued turn.
    expect(runtime.overlay(session.id)!.settings!.permission).toBe('plan');
    expect(agents.resumes.at(-1)!.options.permission).toBe('plan');
    expect(agents.turns.at(-1)!.text).toBe('plan it');
  });

  it('holds a message written while a card waits for an answer, and says so', async () => {
    const { runtime, session, agents, queued } = await setup();
    agents.turns[0]!.emit({ type: 'needs-input', request: { id: 'r1', kind: 'approval', title: 'Run x', detail: 'x', tool: 'Bash', options: [{ id: 'allow', label: 'Allow', role: 'allow' }] } });
    await runtime.idle(session.id);
    await expect(runtime.reply(session.id, 'hello')).resolves.toBe('queued');
    expect(queued()).toEqual(['hello']);
    expect(runtime.overlay(session.id)!.queue!.items[0]!.why).toBe('card');
  });

  it('marks why each message is held when the agent takes none mid-turn', async () => {
    const { runtime, session } = await setup();
    await runtime.reply(session.id, 'one');
    expect(runtime.overlay(session.id)!.queue!.items[0]!.why).toBe('busy');
  });

  it('takes news from other sessions along with the queued turn', async () => {
    const { runtime, session, agents, finishTurn } = await setup();
    await runtime.reply(session.id, 'mine');
    runtime.recordOf(session.id)!.inbox.push('[Kestrel] a child finished');
    await finishTurn();
    expect(agents.turns[1]!.text).toBe('[Kestrel] a child finished\n\nmine');
    expect(runtime.recordOf(session.id)!.inbox).toEqual([]);
  });

  it('still wakes the session for news when nothing is queued', async () => {
    const { runtime, session, agents, finishTurn } = await setup();
    runtime.recordOf(session.id)!.inbox.push('[Kestrel] a child finished');
    await finishTurn();
    expect(agents.turns[1]!.text).toBe('[Kestrel] a child finished');
  });

  it('is stored with the conversation and comes back held after a restart', async () => {
    const { db, data, runtime, session } = await setup();
    await runtime.reply(session.id, 'survive');
    await runtime.shutdown(); // stops the turn and stores everything

    const workspace2 = new Workspace(db);
    const agents2 = new FakeAgents();
    const runtime2 = new SessionRuntime(workspace2, { claude: agents2.adapter() }, data);
    await runtime2.recoverAfterRestart();
    const snap = (await runtime2.snapshot(session.id))!;
    expect(snap.queue).toMatchObject({ held: true, items: [{ text: 'survive' }] });
    await runtime2.sendQueued(session.id);
    await agents2.settled();
    expect(agents2.turns.at(-1)!.text).toBe('survive');
  });

  it('keeps news from other sessions across a restart and sends it with the next turn', async () => {
    const { db, data, runtime, session } = await setup();
    await runtime.queueNews(session, '[Kestrel] a child finished');
    await runtime.shutdown();

    const workspace2 = new Workspace(db);
    const agents2 = new FakeAgents();
    const runtime2 = new SessionRuntime(workspace2, { claude: agents2.adapter() }, data);
    await runtime2.recoverAfterRestart();
    // News that arrives before the session is opened again in this run is kept too.
    expect(runtime2.recordOf(session.id)).toBeUndefined();
    await runtime2.queueNews(session, '[Kestrel] another finished');
    await runtime2.reply(session.id, 'carry on');
    await agents2.settled();
    expect(agents2.turns.at(-1)!.text).toBe('[Kestrel] a child finished\n[Kestrel] another finished\n\ncarry on');

    // Once told, it is not told again after another restart.
    await runtime2.idle(session.id);
    await runtime2.shutdown();
    const runtime3 = new SessionRuntime(new Workspace(db), { claude: new FakeAgents().adapter() }, data);
    await runtime3.recoverAfterRestart();
    expect((await runtime3.queueNews(session, 'x'))!.inbox).toEqual(['x']);
  });
});
