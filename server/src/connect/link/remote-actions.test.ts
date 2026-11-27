// Replying to, answering and stopping a session that runs on another computer (issue 47; account-sessions.md,
// section 9.2): the laptop's window calls the routes it calls for its own sessions, and the laptop asks the Mac
// mini the matching operation of the closed list over a sealed channel. The Mac mini's dispatcher carries it out
// through what its own routes call, with its own checks; a refusal there comes back with its reason, and an
// unreachable Mac mini is named.
import { afterEach, describe, expect, it } from 'vitest';
import { SELECTABLE_AGENTS, type Agent, type ChatMessage } from '../../model.ts';
import { openSuggestions } from '../../shared/suggestions.ts';
import { until } from '../../test-agent.ts';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject } from '../../project-store.ts';
import { BYPASS_FROM_ELSEWHERE } from '../../shared/connect-ops.ts';
import { account, closeDesks, laptopWindow, remoteSession, type Desk } from './two-desks.ts';
import { remoteRunningModes } from '../../shared/start-computer.ts';

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

  it('refuses here what cannot be sent: Bypass, an empty message, a route with no operation', async () => {
    const a = await account();
    const session = await remoteSession(a, 'opencode', 1);
    const w = await laptopWindow(a.laptop, true);
    expect(await w.post(`/api/sessions/${session.id}/reply`, { text: 'go', permission: 'bypass' })).toEqual({ status: 400, body: { error: BYPASS_FROM_ELSEWHERE } });
    expect(await w.post(`/api/sessions/${session.id}/open-file`, { path: 'a.ts', editor: 'code' })).toEqual({ status: 409, body: { error: 'This session runs on Mac mini. That can only be done there.' } });
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

/** What the Mac mini's own window gets for that route of a session: the answer another desktop must get the same. */
async function there(mini: Desk, method: string, path: string, body: Record<string, unknown> = {}) {
  const url = new URL(`http://kestrel${path}`);
  const answer = await mini.page.route(url.pathname.split('/').filter(Boolean), method, url, async () => body);
  return answer && 'body' in answer ? answer.body : answer;
}

/** A session on the Mac mini in a plain folder there, with a file in it; the laptop lists it. */
async function inAFolder(a: Awaited<ReturnType<typeof account>>, agent: Agent) {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-remote-folder-')));
  writeFileSync(join(folder, 'notes.md'), '# Notes\n\nWritten on the Mac mini.\n');
  const project = await createProject(a.mini.workspace, { name: 'Notes', folders: [folder] });
  a.mini.fake.script = (turn) => turn.emit({ type: 'message', id: `a${turn.n}`, text: 'done', delta: 'done', done: true });
  const session = await a.mini.runtime.start({ agent, projectId: project.id, prompt: 'look at the notes' });
  await a.mini.settle();
  await a.mini.desk.held!.run();
  await a.laptop.desk.replica!.run();
  await until(async () => (await a.laptop.workspace.view()).sessions.some((s) => s.id === session.id), 'the laptop lists it');
  return session;
}

describe.each(SELECTABLE_AGENTS)('a %s session on another computer, drawn as one here (Matt, 2026-11-27)', (agent) => {
  it('opens with that computer’s model and mode, and a reply here changes them there', async () => {
    const a = await account();
    const session = await remoteSession(a, agent, 1);
    const w = await laptopWindow(a.laptop, true);
    w.send({ type: 'watch', sessionId: session.id });
    const mode = a.mini.runtime.overlay(session.id)!.settings?.permission;
    await until(() => w.live.some((l) => l.sessionId === session.id && l.patch.settings?.permission === mode), 'its settings arrive');
    expect(await w.post(`/api/sessions/${session.id}/reply`, { text: 'carry on', model: 'faster-model', permission: 'auto', effort: 'high', fast: true })).toEqual({ status: 200, body: { outcome: 'sent' } });
    await a.mini.settle();
    expect(a.mini.runtime.overlay(session.id)!.settings).toMatchObject({ model: 'faster-model', permission: 'auto', effort: 'high', fast: true });
    expect(a.mini.fake.turns.at(-1)!.text).toBe('carry on');
  });

  it('reads the Details sources, the context and the review state there, as its own window does', async () => {
    const a = await account();
    const session = await remoteSession(a, agent, 1);
    const w = await laptopWindow(a.laptop, true);
    for (const section of ['git', 'change-counts', 'repository', 'usage', 'pull-requests', 'context', 'review']) {
      const path = `/api/sessions/${session.id}/${section}`;
      const here = await w.call('GET', path);
      expect(here.status, section).toBe(200);
      expect(here.body, section).toEqual(await there(a.mini, 'GET', path));
    }
  });

  it('reads a file inside the session’s folder there, refuses one outside it with that computer’s words, and carries a document whole', async () => {
    const a = await account();
    const session = await inAFolder(a, agent);
    const w = await laptopWindow(a.laptop, true);
    const file = await w.call('GET', `/api/sessions/${session.id}/file?path=notes.md`);
    expect(file.body).toMatchObject({ kind: 'text', text: '# Notes\n\nWritten on the Mac mini.\n' });
    expect(file.body).toEqual(await there(a.mini, 'GET', `/api/sessions/${session.id}/file?path=notes.md`));
    const outside = await w.call('GET', `/api/sessions/${session.id}/file?path=../../etc/hosts`);
    expect(outside.status).toBe(409);
    expect(outside.body?.error).toBe(((await there(a.mini, 'GET', `/api/sessions/${session.id}/file?path=../../etc/hosts`)) as { error: string }).error);
    const listing = await w.call('GET', `/api/sessions/${session.id}/files?path=`);
    expect(listing.body).toEqual(await there(a.mini, 'GET', `/api/sessions/${session.id}/files?path=`));
    const doc = await w.call('GET', `/api/sessions/${session.id}/document?path=notes.md`);
    expect(doc.status).toBe(200);
    expect(doc.bytes.toString('utf8')).toBe('# Notes\n\nWritten on the Mac mini.\n');
    // Nothing of the file crossed the relay in the clear.
    expect(a.relay.carried.some((f) => f.includes('Written on the Mac mini'))).toBe(false);
  });

  it('renames, tags, and carries any file the message box takes, there', async () => {
    const a = await account();
    const session = await remoteSession(a, agent, 1);
    const w = await laptopWindow(a.laptop, true);
    expect((await w.call('PATCH', `/api/sessions/${session.id}`, { title: 'Checkout flow' })).status).toBe(204);
    expect((await a.mini.workspace.state()).sessions.find((s) => s.id === session.id)!.title).toBe('Checkout flow');
    expect(await w.call('POST', `/api/sessions/${session.id}/tags`, { tag: 'release' })).toMatchObject({ status: 200, body: { tags: ['release'] } });
    expect(await w.call('DELETE', `/api/sessions/${session.id}/tags/release`)).toMatchObject({ status: 200, body: { tags: [] } });
    const script = await w.upload('draft-2', 'run.sh', 'text/x-sh', Buffer.from('echo hi'));
    expect(await w.post(`/api/sessions/${session.id}/reply`, { text: 'run it', draftId: 'draft-2', attachments: [script.id] })).toEqual({ status: 200, body: { outcome: 'sent' } });
    await a.mini.settle();
    expect(a.mini.fake.turns.at(-1)!.attachments.map((f) => f.name)).toEqual(['run.sh']);
  });

  it('a command’s output, a held message and a refusal there come back as its own window has them', async () => {
    const a = await account();
    const session = await remoteSession(a, agent, 1);
    const w = await laptopWindow(a.laptop, true);
    const missing = await w.call('GET', `/api/sessions/${session.id}/commands/c9/output`);
    expect(missing.status).toBe(409);
    await expect(a.mini.runtime.commandOutput(session.id, 'c9')).rejects.toThrow(missing.body!.error!);
    // A message no longer held: its refusal there, in its words.
    const unheld = await w.call('DELETE', `/api/sessions/${session.id}/queue/q9`);
    expect(unheld.status).toBe(409);
    await expect(a.mini.runtime.removeQueued(session.id, 'q9')).rejects.toThrow(unheld.body!.error!);
  });
});

describe.each(SELECTABLE_AGENTS)('a %s session on another computer, archived from this one (Matt, 2026-11-27: "Archive should be allowed from anywhere")', (agent) => {
  /** The Mac mini holds what changed, and the laptop reads it. */
  const sync = async (a: Awaited<ReturnType<typeof account>>) => {
    await a.mini.desk.held!.run();
    await a.laptop.desk.replica!.run();
  };

  it('archives it there through the window’s own archive, lists it under Archived here, and restores it there', async () => {
    const a = await account();
    const session = await remoteSession(a, agent, 1);
    const w = await laptopWindow(a.laptop, true);
    expect(await w.post('/api/archive', { kind: 'session', id: session.id, archived: true })).toMatchObject({ status: 204 });
    expect((await a.mini.workspace.state()).archived.sessions.map((s) => s.id)).toEqual([session.id]);
    await sync(a);
    const view = await a.laptop.workspace.view();
    expect(view.sessions.some((s) => s.id === session.id)).toBe(false);
    expect(view.archived.sessions.find((s) => s.id === session.id)?.runsOn).toBe(a.mini.id());

    // Undo, or Restore in Settings → Archived: the same action the other way, and it is back in the sidebar here.
    expect(await w.post('/api/archive', { kind: 'session', id: session.id, archived: false })).toMatchObject({ status: 204 });
    expect((await a.mini.workspace.state()).sessions.map((s) => s.id)).toEqual([session.id]);
    await sync(a);
    await until(async () => (await a.laptop.workspace.view()).sessions.some((s) => s.id === session.id), 'it is listed again here');
  });

  it('a refusal there comes back in its words, and an unreachable computer is named; nothing is held', async () => {
    const a = await account();
    const session = await remoteSession(a, agent, 1);
    const w = await laptopWindow(a.laptop, true);
    a.mini.fake.hold = true;
    await a.mini.runtime.reply(session.id, 'keep going');
    await until(async () => (await stateThere(a.mini, session.id)) === 'running', 'it works there');
    const refused = await w.post('/api/archive', { kind: 'session', id: session.id, archived: true });
    expect(refused.status).toBe(409);
    await expect(a.mini.workspace.setArchived('session', session.id, true)).rejects.toThrow(refused.body!.error!);
    a.mini.fake.turns.at(-1)!.done();
    await a.mini.settle();

    await a.mini.desk.setEnabled(false);
    const away = await w.post('/api/archive', { kind: 'session', id: session.id, archived: true });
    expect(away.status).toBe(503);
    expect(away.body?.error).toMatch(/^Mac mini cannot be reached, so nothing was done there\./);
    expect((await a.mini.workspace.state()).archived.sessions).toEqual([]);
  });
});

describe('a session on another computer, opened in a window here', () => {
  it('starts from that computer’s page: its files, model and mode, and its pull requests, asked once', async () => {
    const a = await account();
    const session = await inAFolder(a, 'claude');
    const w = await laptopWindow(a.laptop, true);
    w.send({ type: 'watch', sessionId: session.id });
    await until(() => w.live.some((l) => l.patch.settings !== undefined && l.patch.files !== undefined), 'the page’s state arrives');
    // Its pull requests are pushed as they change there, held once in the window's own slice: no timer asks again.
    const lookup = await w.call('GET', `/api/sessions/${session.id}/pull-requests?refresh=1`);
    expect(lookup.status).toBe(200);
    await until(() => w.pullRequests.some((changes) => changes[session.id] !== undefined), 'its pull requests are pushed');
  });

  it('a computer that cannot be reached is named in the Changes pane, and nothing is held for it', async () => {
    const a = await account();
    const session = await remoteSession(a, 'codex', 1);
    const w = await laptopWindow(a.laptop, true);
    await a.mini.desk.setEnabled(false);
    w.send({ type: 'watch', sessionId: session.id });
    await until(() => w.live.some((l) => typeof l.patch.filesProblem === 'string'), 'the pane says why');
    expect(w.live.find((l) => typeof l.patch.filesProblem === 'string')!.patch.filesProblem).toMatch(/^Mac mini cannot be reached, so its changes cannot be shown now\./);
    expect((await w.call('GET', `/api/sessions/${session.id}/git`)).body?.error).toMatch(/^Mac mini cannot be reached/);
  });
});

// Issue 79 (Matt, 2026-11-27: "why not just allow the user to see / change as if it were local?"). Through the desks
// and the fake relay alone, no window here, so these run where a test may not open a port.
describe.each(SELECTABLE_AGENTS)('the model and mode of a %s session on another computer (issue 79)', (agent) => {
  const headHere = async (laptop: Desk, id: string) => (await laptop.workspace.account.head(id))?.settings;

  it('are read here from its head, and changed there by a desktop’s reply, every mode its agent has but Bypass', async () => {
    const a = await account();
    const session = await remoteSession(a, agent, 1);
    const there = a.mini.runtime.overlay(session.id)!.settings!;
    expect(await headHere(a.laptop, session.id)).toEqual(there);

    const modes = remoteRunningModes((await a.mini.runtime.capabilities(agent)).permissions, there.permission).filter((m) => m !== 'bypass' && m !== there.permission);
    expect(modes.length).toBeGreaterThan(0);
    for (const permission of modes) {
      const answer = await a.laptop.desk.remote.ask(a.mini.id(), 'session.reply', { sessionId: session.id, text: `now in ${permission}`, model: 'faster-model', permission });
      expect(answer).toMatchObject({ ok: true });
      await a.mini.settle();
      expect(a.mini.runtime.overlay(session.id)!.settings).toMatchObject({ model: 'faster-model', permission });
    }
    // Said in its head, so every computer of the account shows it at once.
    await a.mini.desk.held!.run();
    await a.laptop.desk.replica!.run();
    await until(async () => (await headHere(a.laptop, session.id))?.permission === modes.at(-1), 'the new mode reaches the head here');
    expect(await headHere(a.laptop, session.id)).toMatchObject({ model: 'faster-model' });
  });

  it('never switches Bypass on from another computer, and a session in Bypass there shows it and may leave it', async () => {
    const a = await account();
    const session = await remoteSession(a, agent, 1);
    const refused = await a.laptop.desk.remote.ask(a.mini.id(), 'session.reply', { sessionId: session.id, text: 'go', permission: 'bypass' });
    expect(refused).toEqual({ ok: false, reached: true, reason: BYPASS_FROM_ELSEWHERE });
    await a.mini.settle();
    expect(a.mini.runtime.overlay(session.id)!.settings?.permission).not.toBe('bypass');

    // Switched on at that computer's own window: shown here as Bypass, and changed away from it from here.
    await a.mini.runtime.reply(session.id, 'at the desk', { permission: 'bypass' });
    await a.mini.settle();
    await a.mini.desk.held!.run();
    await a.laptop.desk.replica!.run();
    await until(async () => (await headHere(a.laptop, session.id))?.permission === 'bypass', 'Bypass shows here');
    expect(await a.laptop.desk.remote.ask(a.mini.id(), 'session.reply', { sessionId: session.id, text: 'calmer', permission: 'auto' })).toMatchObject({ ok: true });
    await a.mini.settle();
    expect(a.mini.runtime.overlay(session.id)!.settings?.permission).toBe('auto');
  });

  it('are still shown from the head while that computer cannot be reached, and a change is refused naming it', async () => {
    const a = await account();
    const session = await remoteSession(a, agent, 1);
    await a.mini.desk.setEnabled(false);
    expect(await headHere(a.laptop, session.id)).toMatchObject({ permission: a.mini.runtime.overlay(session.id)!.settings!.permission });
    const answer = await a.laptop.desk.remote.ask(a.mini.id(), 'session.reply', { sessionId: session.id, text: 'go', permission: 'auto' });
    expect(answer).toMatchObject({ ok: false, reached: false });
  });
});
