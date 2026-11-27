// New session on another computer of the account (issue 52; account-sessions.md, "Starting a session on another
// computer, as built"): the laptop's window posts `POST /api/sessions` naming the Mac mini, the laptop asks it
// `session.start` over a sealed channel, and the Mac mini's dispatcher takes a desktop's start exactly as a phone's,
// with the same switch. The new session is listed on the laptop at once, from the answer.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SELECTABLE_AGENTS } from '../../model.ts';
import { BYPASS_FROM_ELSEWHERE } from '../../shared/connect-ops.ts';
import { until } from '../../test-agent.ts';
import { account, closeDesks, laptopWindow, remoteSession } from './two-desks.ts';

afterEach(closeDesks);

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** Two computers, the Mac mini with a project the laptop lists as away, and the laptop's window. */
async function withAwayProject() {
  const a = await account();
  await remoteSession(a, 'claude', 1);
  const w = await laptopWindow(a.laptop, true);
  const project = (await a.laptop.workspace.view()).projects.find((p) => p.away)!;
  return { a, w, project };
}

describe.each(SELECTABLE_AGENTS)('a %s session started on another computer from this one', (agent) => {
  it('starts there in the chosen project and mode with the first message and its picture, and is listed here at once', async () => {
    const { a, w, project } = await withAwayProject();
    const photo = await w.upload('draft-new', 'screen.png', 'image/png', PNG);
    const sent = await w.post('/api/sessions', { machine: a.mini.id(), agent, projectId: project.id, prompt: 'fix the build', permission: 'auto', draftId: 'draft-new', attachments: [photo.id] });
    expect(sent.status).toBe(201);
    const id = sent.body!.id as string;
    expect(sent.body).toEqual({ id, runsOn: a.mini.id() });

    await a.mini.settle();
    const there = (await a.mini.workspace.state()).sessions.find((s) => s.id === id)!;
    expect(there).toMatchObject({ agent, startedIn: project.elsewhere!.machines[0]!.projectId });
    const turn = a.mini.fake.turns.at(-1)!;
    expect(turn.options.permission).toBe('auto');
    expect(turn.text).toBe('fix the build');
    expect(turn.attachments.map((f) => f.name)).toEqual(['screen.png']);

    // Here at once, from the answer, before the service has its head: in the same project, running there.
    const here = (await a.laptop.workspace.view()).sessions.find((s) => s.id === id);
    expect(here).toMatchObject({ runsOn: a.mini.id(), agent, startedIn: project.id });
    // Sent there, so the draft here is gone.
    expect(() => a.laptop.runtime.attachments.draftFiles({ draftId: 'draft-new', ids: [photo.id] })).toThrow(/no longer there/);
  });
});

describe('what a start on another computer refuses', () => {
  it('is refused with that computer’s own words while its switch is off, and nothing starts there', async () => {
    const { a, w, project } = await withAwayProject();
    await a.mini.runtime.remoteStarts.setAllowed(false);
    const before = (await a.mini.workspace.state()).sessions.length;
    const refused = await w.post('/api/sessions', { machine: a.mini.id(), agent: 'claude', projectId: project.id, prompt: 'hello', permission: 'ask' });
    expect(refused).toEqual({ status: 409, body: { error: 'Starting sessions on Mac mini from other devices is off in its Settings.' } });
    expect((await a.mini.workspace.state()).sessions).toHaveLength(before);
  });

  it('sends no picture for a start that computer already says it refuses, and keeps it in the box here', async () => {
    const { a, w, project } = await withAwayProject();
    await a.mini.runtime.remoteStarts.setAllowed(false);
    const photo = await w.upload('draft-off', 'screen.png', 'image/png', PNG);
    const refused = await w.post('/api/sessions', { machine: a.mini.id(), agent: 'claude', projectId: project.id, prompt: 'hello', permission: 'ask', draftId: 'draft-off', attachments: [photo.id] });
    expect(refused).toEqual({ status: 409, body: { error: 'Starting sessions on Mac mini from other devices is off in its Settings.' } });
    const miniDrafts = join((a.mini.runtime.attachments as unknown as { root: string }).root, 'drafts');
    expect(existsSync(miniDrafts) ? readdirSync(miniDrafts) : []).toEqual([]);
    expect(a.laptop.runtime.attachments.draftFiles({ draftId: 'draft-off', ids: [photo.id] })).toHaveLength(1);
  });

  it('names a computer that cannot be reached, and holds nothing for it', async () => {
    const { a, w, project } = await withAwayProject();
    await a.mini.desk.setEnabled(false);
    const refused = await w.post('/api/sessions', { machine: a.mini.id(), agent: 'claude', projectId: project.id, prompt: 'hello', permission: 'ask' });
    expect(refused.status).toBe(503);
    expect(refused.body?.error).toMatch(/^Mac mini cannot be reached, so nothing was done there\./);
  });

  it('never starts in Bypass, nor in a mode other than Manual or Auto, and asks nothing of the other computer', async () => {
    const { a, w, project } = await withAwayProject();
    const before = (await a.mini.workspace.state()).sessions.length;
    expect(await w.post('/api/sessions', { machine: a.mini.id(), agent: 'claude', projectId: project.id, prompt: 'hello', permission: 'bypass' })).toEqual({ status: 409, body: { error: BYPASS_FROM_ELSEWHERE } });
    expect(await w.post('/api/sessions', { machine: a.mini.id(), agent: 'claude', projectId: project.id, prompt: 'hello', permission: 'plan' })).toEqual({ status: 409, body: { error: 'A session on Mac mini starts in Manual or Auto from here.' } });
    expect((await a.mini.workspace.state()).sessions).toHaveLength(before);
  });

  it('refuses a file that is not a picture, a project that computer does not have, and a computer not of the account', async () => {
    const { a, w } = await withAwayProject();
    const notes = await w.upload('draft-notes', 'run.sh', 'text/x-sh', Buffer.from('echo hi'));
    expect((await w.post('/api/sessions', { machine: a.mini.id(), agent: 'claude', projectId: null, prompt: 'hello', permission: 'ask', draftId: 'draft-notes', attachments: [notes.id] })).body?.error).toBe('Only pictures can go with a message to a session on Mac mini. run.sh is not one.');
    const mine = await a.laptop.workspace.addProject({ id: 'mine', name: 'Mine', path: '/repos/mine', isGit: true });
    expect((await w.post('/api/sessions', { machine: a.mini.id(), agent: 'claude', projectId: mine.id, prompt: 'hello', permission: 'ask' })).body?.error).toBe('Mac mini does not have Mine. Clone it there first, or pick a project it has.');
    expect((await w.post('/api/sessions', { machine: 'not-a-computer', agent: 'claude', projectId: null, prompt: 'hello', permission: 'ask' })).status).toBe(409);
  });
});

describe('the computers a New session may run on', () => {
  it('lists the account’s other computers, and what each offers when asked', async () => {
    const { a, w } = await withAwayProject();
    expect(await w.get('/api/start-computers')).toEqual({ computers: [{ id: a.mini.id(), name: 'Mac mini' }] });
    const offered = (await w.get(`/api/start-computers/${a.mini.id()}`)) as { ok: boolean; choices: { allowed: boolean; providers: { agent: string }[] } };
    expect(offered.ok).toBe(true);
    expect(offered.choices.allowed).toBe(true);
    expect(offered.choices.providers.map((p) => p.agent)).toEqual(expect.arrayContaining(['claude']));
    await a.mini.runtime.remoteStarts.setAllowed(false);
    expect(await w.get(`/api/start-computers/${a.mini.id()}`)).toMatchObject({ ok: true, choices: { allowed: false, refusal: 'Starting sessions on Mac mini from other devices is off in its Settings.' } });
  });

  it('answers from what the computer published, at once and with it out of reach', async () => {
    const { a, w } = await withAwayProject();
    const live = (await w.get(`/api/start-computers/${a.mini.id()}`)) as { ok: true; choices: Record<string, unknown> };
    // What the Mac mini holds on the account, as this computer's copy has it; then the Mac mini goes away.
    const offers = { ...live.choices, here: 'Mac mini (published)' } as never;
    await a.laptop.workspace.accountOffers.apply({ offers: [{ machine: { id: a.mini.id(), name: 'Mac mini' }, made: 1, offers }], gone: [], members: [a.mini.id()], whole: true, mark: null });
    await a.mini.desk.setEnabled(false);
    expect(await w.get(`/api/start-computers/${a.mini.id()}`)).toMatchObject({ ok: true, choices: { here: 'Mac mini (published)' } });
  });

  it('says a computer that cannot be reached cannot be asked', async () => {
    const { a, w } = await withAwayProject();
    await a.mini.desk.setEnabled(false);
    await until(async () => ((await w.get(`/api/start-computers/${a.mini.id()}`)) as { ok: boolean }).ok === false, 'the Mac mini is out of reach');
    expect(await w.get(`/api/start-computers/${a.mini.id()}`)).toEqual({ ok: false, reason: 'Mac mini cannot be reached now.' });
  });
});

// Item 81: Matt started a session on a worker node from his Mac; the first answer came after the Mac gave up, the
// node carried on, and the second Enter made a second session. A start carries an id, is waited for as long as a
// start takes, is asked again with the same id when late, and the other computer answers a repeat with the same session.
describe('a start on another computer is asked once and happens once', () => {
  /** The Mac mini accepts each start only after `ms`, as a cold node's first start does. */
  function slowStarts(a: Awaited<ReturnType<typeof account>>, ms: number): () => number {
    const real = a.mini.runtime.start.bind(a.mini.runtime);
    let starts = 0;
    a.mini.runtime.start = async (req) => {
      starts++;
      await new Promise((resolve) => setTimeout(resolve, ms));
      return real(req);
    };
    return () => starts;
  }
  const sessionsOn = async (d: { workspace: { state: () => Promise<{ sessions: { id: string }[] }> } }) => (await d.workspace.state()).sessions.map((s) => s.id);

  it('a start answered after the wait makes one session, and this computer ends up showing it', async () => {
    const a = await account();
    const w = await laptopWindow(a.laptop, true, { startTimeoutMs: 300 });
    const before = await sessionsOn(a.mini);
    const asked = slowStarts(a, 450);
    const sent = await w.post('/api/sessions', { machine: a.mini.id(), agent: 'claude', projectId: null, prompt: 'hello', permission: 'ask', startId: 'draft-1' });
    expect(sent.status).toBe(201);
    const id = sent.body!.id as string;
    await a.mini.settle();
    expect((await sessionsOn(a.mini)).filter((s) => !before.includes(s))).toEqual([id]);
    // The retry waited for the first, which it found under way: one start.
    expect(asked()).toBe(1);
    expect((await a.laptop.workspace.view()).sessions.some((s) => s.id === id)).toBe(true);
  });

  it('the same id asked twice makes one session; no id behaves as before', async () => {
    const a = await account();
    const w = await laptopWindow(a.laptop, true);
    const body = { machine: a.mini.id(), agent: 'claude', projectId: null, prompt: 'hello', permission: 'ask', startId: 'draft-2' };
    const first = await w.post('/api/sessions', body);
    const second = await w.post('/api/sessions', body);
    expect(first.status).toBe(201);
    expect(second.body).toEqual(first.body);
    await a.mini.settle();
    expect((await sessionsOn(a.mini)).filter((id) => id === first.body!.id)).toHaveLength(1);

    // An older device sends no id: each start is a start.
    const count = (await sessionsOn(a.mini)).length;
    const ask = () => a.laptop.desk.remote.ask(a.mini.id(), 'session.start', { text: 'old device', mode: 'ask' });
    const [x, y] = [await ask(), await ask()];
    expect(x.ok && y.ok).toBe(true);
    expect((x as { result: { sessionId: string } }).result.sessionId).not.toBe((y as { result: { sessionId: string } }).result.sessionId);
    await a.mini.settle();
    expect(await sessionsOn(a.mini)).toHaveLength(count + 2);
  });

  it('late every time: says it may have started there, and it then starts once', async () => {
    const a = await account();
    const w = await laptopWindow(a.laptop, true, { startTimeoutMs: 200 });
    const before = await sessionsOn(a.mini);
    slowStarts(a, 700);
    const sent = await w.post('/api/sessions', { machine: a.mini.id(), agent: 'claude', projectId: null, prompt: 'hello', permission: 'ask', startId: 'draft-3' });
    expect(sent).toEqual({ status: 504, body: { error: 'Mac mini did not answer in time. If the session started there it will show in the sidebar.' } });
    await until(async () => (await sessionsOn(a.mini)).length > before.length, 'it starts there after all');
    await a.mini.settle();
    expect((await sessionsOn(a.mini)).filter((s) => !before.includes(s))).toHaveLength(1);
  });
});
