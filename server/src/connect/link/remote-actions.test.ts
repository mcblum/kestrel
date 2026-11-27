// Replying to, answering and stopping a session that runs on another computer (issue 47; account-sessions.md,
// section 9.2): the laptop's window calls the routes it calls for its own sessions, and the laptop asks the Mac
// mini the matching operation of the closed list over a sealed channel. The Mac mini's dispatcher carries it out
// through what its own routes call, with its own checks; a refusal there comes back with its reason, and an
// unreachable Mac mini is named.
import { afterEach, describe, expect, it } from 'vitest';
import { SELECTABLE_AGENTS, type Agent, type ChatMessage } from '../../model.ts';
import { openSuggestions } from '../../shared/suggestions.ts';
import { until } from '../../test-agent.ts';
import { account, closeDesks, laptopWindow, remoteSession, type Desk } from './two-desks.ts';

afterEach(closeDesks);

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** The card of that id in the Mac mini's conversation, as its window has it. */
const cardThere = (mini: Desk, sessionId: string, cardId: string) => mini.runtime.overlay(sessionId)?.messages.find((m: ChatMessage) => m.input?.id === cardId)?.input;
const stateThere = async (mini: Desk, sessionId: string) => (await mini.workspace.state()).sessions.find((s) => s.id === sessionId)?.state;

/** A session on the Mac mini whose next turn raises `request` and waits; the laptop can reach it. */
async function waitingOnCard(agent: Agent, request: Record<string, unknown>) {
  const a = await account();
  const session = await remoteSession(a, agent, 1);
  const w = await laptopWindow(a.laptop);
  a.mini.fake.hold = true;
  a.mini.fake.script = (turn) => turn.emit({ type: 'needs-input', request: request as never });
  await a.mini.runtime.reply(session.id, 'go on');
  await until(() => cardThere(a.mini, session.id, String(request.id)) !== undefined, 'the card is raised there');
  return { a, session, w };
}

describe.each(SELECTABLE_AGENTS)('a %s session on another computer, acted on from this one', (agent) => {
  it('a reply with a picture starts a turn there, and the draft here goes', async () => {
    const a = await account();
    const session = await remoteSession(a, agent, 1);
    const w = await laptopWindow(a.laptop, true);
    const photo = await w.upload('draft-here', 'screen.png', 'image/png', PNG);
    const sent = await w.post(`/api/sessions/${session.id}/reply`, { text: 'look at this', draftId: 'draft-here', attachments: [photo.id] });
    expect(sent).toEqual({ status: 200, body: { outcome: 'sent' } });
    await a.mini.settle();
    const turn = a.mini.fake.turns.at(-1)!;
    expect(turn.text).toBe('look at this');
    expect(turn.attachments.map((f) => f.name)).toEqual(['screen.png']);
    // Sent there, so the draft here is gone: the same message cannot go twice.
    expect(() => a.laptop.runtime.attachments.draftFiles({ draftId: 'draft-here', ids: [photo.id] })).toThrow(/no longer there/);
    // Nothing of it crossed the relay in the clear.
    expect(a.relay.carried.some((f) => f.includes('look at this'))).toBe(false);
  });

  it('an approval card answered here is answered there', async () => {
    const { a, session, w } = await waitingOnCard(agent, { id: 'c1', kind: 'approval', title: 'Run a command', detail: 'make', tool: 'Bash', options: [{ id: 'allow', label: 'Allow', role: 'allow' }, { id: 'deny', label: 'Deny', role: 'deny' }] });
    expect(await w.post(`/api/sessions/${session.id}/answer`, { requestId: 'c1', optionId: 'allow' })).toEqual({ status: 204, body: null });
    await until(() => cardThere(a.mini, session.id, 'c1')?.resolved !== undefined, 'the card is answered there');
    // Its refusal, said there, is the window's here: the card no longer waits.
    expect(await w.post(`/api/sessions/${session.id}/answer`, { requestId: 'c1', optionId: 'deny' })).toEqual({ status: 409, body: { error: 'That card is no longer waiting for an answer.' } });
  });

  it('a question card answered here is answered there', async () => {
    const { a, session, w } = await waitingOnCard(agent, { id: 'q1', kind: 'question', tool: '', title: 'A question', detail: 'Which?', options: [], questions: [{ question: 'Which?', options: [{ label: 'This' }, { label: 'That' }] }] });
    expect((await w.post(`/api/sessions/${session.id}/answer`, { requestId: 'q1', answers: { 'Which?': 'That' } })).status).toBe(204);
    await until(() => cardThere(a.mini, session.id, 'q1')?.resolved !== undefined, 'the question is answered there');
  });

  it('Stop ends the turn there', async () => {
    const a = await account();
    const session = await remoteSession(a, agent, 1);
    const w = await laptopWindow(a.laptop);
    a.mini.fake.hold = true;
    a.mini.fake.script = () => undefined;
    expect((await w.post(`/api/sessions/${session.id}/reply`, { text: 'a long job' })).body).toEqual({ outcome: 'sent' });
    await until(async () => (await stateThere(a.mini, session.id)) === 'running', 'the turn runs there');
    expect(await w.post(`/api/sessions/${session.id}/stop`)).toEqual({ status: 204, body: null });
    await until(async () => (await stateThere(a.mini, session.id)) !== 'running', 'the turn ends there');
  });
});

describe('what is asked of the other computer, and what is refused here', () => {
  it('compact and a suggestion card go through their own operations', async () => {
    const a = await account();
    a.mini.fake.script = async (turn) => {
      if (turn.n === 1) await turn.options.tools.suggest({ kind: 'tag', tag: 'PROJ-482', category: 'ticket', source: 'Jira', reason: 'The task names PROJ-482.' } as never);
    };
    const session = await a.mini.runtime.start({ agent: 'claude', projectId: null, prompt: 'Fix PROJ-482' });
    await a.mini.settle();
    await a.mini.desk.held!.run();
    await a.laptop.desk.replica!.run();
    await until(async () => (await a.laptop.workspace.view()).sessions.some((s) => s.id === session.id), 'the laptop lists it');
    const w = await laptopWindow(a.laptop);
    const [card] = openSuggestions(a.mini.runtime.recordOf(session.id)!.messages);
    const answered = await w.post(`/api/sessions/${session.id}/suggestions/${card!.id}/answer`, { button: 'tag' });
    expect(answered).toMatchObject({ status: 200, body: { suggestion: { id: card!.id, state: 'answered' } } });
    expect((await a.mini.workspace.state()).sessions.find((s) => s.id === session.id)!.tags).toContain('PROJ-482');
    expect(await w.post(`/api/sessions/${session.id}/compact`)).toEqual({ status: 200, body: { compacting: true } });
    await a.mini.settle();
    expect(a.mini.fake.compactions).toHaveLength(1);
  });

  it('opening it here marks it seen there too', async () => {
    const a = await account();
    const session = await remoteSession(a, 'codex', 1);
    const w = await laptopWindow(a.laptop);
    await a.mini.workspace.seen.markUnread(session.id);
    expect((await w.post('/api/seen', { sessionIds: [session.id] })).status).toBe(200);
    expect((await a.laptop.workspace.seen.view())[session.id]).toBeGreaterThan(0);
    await until(async () => ((await a.mini.workspace.seen.view())[session.id] ?? 0) > 0, 'seen there');
  });

  it('refuses here what cannot be sent: a model or mode change, a file that is not a picture, a route with no operation', async () => {
    const a = await account();
    const session = await remoteSession(a, 'opencode', 1);
    const w = await laptopWindow(a.laptop, true);
    expect(await w.post(`/api/sessions/${session.id}/reply`, { text: 'go', permission: 'bypass' })).toEqual({ status: 409, body: { error: 'This session runs on Mac mini. Its model and mode are changed there.' } });
    const script = await w.upload('draft-2', 'run.sh', 'text/x-sh', Buffer.from('echo hi'));
    expect(await w.post(`/api/sessions/${session.id}/reply`, { text: 'run it', draftId: 'draft-2', attachments: [script.id] })).toEqual({ status: 409, body: { error: 'Only pictures can go with a message to a session on Mac mini. run.sh is not one.' } });
    // The draft stays, so the message box keeps it.
    expect(a.laptop.runtime.attachments.draftFiles({ draftId: 'draft-2', ids: [script.id] })).toHaveLength(1);
    expect(await w.post(`/api/sessions/${session.id}/queue/send`)).toEqual({ status: 409, body: { error: 'This session runs on Mac mini. That can only be done there.' } });
    expect(await w.post(`/api/sessions/${session.id}/reply`, { text: '' })).toMatchObject({ status: 400 });
    expect(a.mini.fake.turns).toHaveLength(1);
  });

  it('an unreachable computer is named, and nothing is held for it', async () => {
    const a = await account();
    const session = await remoteSession(a, 'claude', 1);
    const w = await laptopWindow(a.laptop);
    await a.mini.desk.setEnabled(false);
    const refused = await w.post(`/api/sessions/${session.id}/reply`, { text: 'are you there?' });
    expect(refused.status).toBe(503);
    expect(refused.body?.error).toMatch(/^Mac mini cannot be reached, so nothing was done there\..* Try again when it is back\.$/);
    expect((await w.post(`/api/sessions/${session.id}/stop`)).body?.error).toMatch(/^Mac mini cannot be reached/);
    await a.mini.settle();
    expect(a.mini.fake.turns).toHaveLength(1);
  });
});
