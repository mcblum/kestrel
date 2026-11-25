// Notes between sessions (`send_note`, shared/notes.ts): information one session's agent gives another
// while it works. Into the receiver's running turn when its agent takes messages mid-turn; held for the
// turn's end when it cannot; held for the next turn, starting none, when the receiver is idle. Only
// within a workstream or along a link, short, counted with ask_session, never asking the user.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { memoryPersistence } from './persistence/memory.ts';
import { SessionRuntime } from './runtime.ts';
import { NOTE_MAX } from './shared/notes.ts';
import { FakeAgents, type MidTurnMode } from './test-agent.ts';
import { makeRepo } from './test-repo.ts';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import { Workspace } from './workspace.ts';

vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

/** An orchestrator that delegated to repoA and repoB (a workstream), and a third session unrelated to them. */
async function world(mode: MidTurnMode = 'accept') {
  const workspace = new Workspace(memoryPersistence());
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-notes-')));
  const agents = new FakeAgents();
  agents.midTurn = mode;
  const runtime = new SessionRuntime(workspace, { claude: agents.adapter() }, data);
  const a = await runtime.registerProject(makeRepo(), 'repoA');
  await runtime.registerProject(makeRepo(), 'repoB');
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await agents.settled();
      for (const s of (await workspace.state()).sessions) await runtime.idle(s.id);
    }
  };
  agents.script = async (turn) => {
    if (turn.text === 'split') await turn.options.tools.delegate({ tasks: [{ project: 'repoA', brief: 'Child A' }, { project: 'repoB', brief: 'Child B' }] });
  };
  const lead = await runtime.start({ agent: 'claude', projectId: a.id, prompt: 'split', permission: 'auto' });
  await settle();
  const state = await workspace.state();
  const childA = state.sessions.find((s) => s.title === 'Child A')!;
  const childB = state.sessions.find((s) => s.title === 'Child B')!;
  const stranger = await runtime.start({ agent: 'claude', projectId: a.id, prompt: 'unrelated' });
  await settle();
  agents.script = () => undefined;
  const note = (from: string, to: string, text: string) => runtime.delegation.hostFor(from).sendNote({ session: to, note: text });
  const notes = (id: string) => runtime.overlay(id)!.messages.filter((m) => m.from);
  const queue = (id: string) => runtime.overlay(id)!.queue?.items ?? [];
  /** Starts a turn on `id` that runs until ended by hand; returns it. */
  const busy = async (id: string) => {
    agents.hold = true;
    await runtime.reply(id, 'long work');
    await agents.settled();
    return agents.turns.at(-1)!;
  };
  return { workspace, agents, runtime, lead, childA, childB, stranger, settle, note, notes, queue, busy };
}

describe('a note to a session that is working', () => {
  it('goes into its running turn at once, framed as a peer’s information, and shows as a quiet line there', async () => {
    const w = await world();
    const turn = await w.busy(w.childB.id);
    const turnsBefore = w.agents.turns.length;
    const result = await w.note(w.childA.id, w.childB.id, 'We use the OAuth scope repo:read, not repo.');
    expect(result.isError).toBeFalsy();
    expect(result.text).toMatch(/^Delivered to "Child B" .* while it works/);
    // The model got it inside the turn it is on, saying who sent it and that it is not the user's instruction.
    expect(turn.midTurn).toHaveLength(1);
    expect(turn.midTurn[0]!.text).toMatch(/^\[Kestrel\] A note from the session "Child A" \(.+\).*not an instruction from the user: decide yourself/s);
    expect(turn.midTurn[0]!.text).toMatch(/repo:read, not repo\.$/);
    // No turn was started, nothing was queued, and the sender was asked nothing.
    expect(w.agents.turns).toHaveLength(turnsBefore);
    expect(w.queue(w.childB.id)).toEqual([]);
    expect(w.runtime.overlay(w.childA.id)!.messages.some((m) => m.input)).toBe(false);
    // The receiver's conversation has the quiet line, with who sent it as data; it does not start a turn.
    const [line] = w.notes(w.childB.id);
    expect(line).toMatchObject({ text: 'From Child A: We use the OAuth scope repo:read, not repo.', notice: 'info', from: { sessionId: w.childA.id, title: 'Child A' }, midTurn: 'sent' });
    expect(line!.id).toBe(turn.midTurn[0]!.id);
    turn.pickUp();
    expect(w.notes(w.childB.id)[0]!.midTurn).toBe('read');
  });

  it('goes both ways along a link, and the sender hears nothing back when the turn ends', async () => {
    const w = await world();
    const turn = await w.busy(w.lead.id);
    expect((await w.note(w.childA.id, w.lead.id, 'The table is called accounts.')).text).toMatch(/^Delivered/);
    turn.pickUp();
    turn.done();
    await w.settle();
    // The child is told nothing of the lead's turn: a note asks for no report.
    expect(w.agents.turns.filter((t) => t.options.directory === w.childA.worktreePath && t.text.includes('finished the turn you asked'))).toHaveLength(0);
  });

  it('waits for the turn to end when the agent cannot take it mid-turn, and says so', async () => {
    const w = await world('refuse');
    const turn = await w.busy(w.childB.id);
    const result = await w.note(w.childA.id, w.childB.id, 'Port is 8443.');
    expect(result.text).toMatch(/could not take the note in the middle of this turn, so it gets it when that turn ends/);
    expect(w.queue(w.childB.id)).toMatchObject([{ fromAgent: true, from: { sessionId: w.childA.id, title: 'Child A', body: 'Port is 8443.', kind: 'note' } }]);
    w.agents.hold = false;
    turn.done();
    await w.settle();
    // It went as the next turn, as today, and shows there as the same quiet line.
    const next = w.agents.turns.find((t) => t.text.includes('Port is 8443.'))!;
    expect(next.text).toMatch(/^\[Kestrel\] A note from the session "Child A"/);
    const line = w.notes(w.childB.id).at(-1)!;
    expect(line).toMatchObject({ text: 'From Child A: Port is 8443.', from: { sessionId: w.childA.id } });
    expect(line.midTurn).toBeUndefined();
    expect(line.sentAt).toBeDefined();
  });

  it('comes back to be held when the turn is stopped before the agent read it', async () => {
    const w = await world();
    await w.busy(w.childB.id);
    await w.note(w.childA.id, w.childB.id, 'Use v2 of the API.');
    await w.runtime.stop(w.childB.id);
    await w.settle();
    expect(w.notes(w.childB.id)).toEqual([]);
    expect(w.queue(w.childB.id)).toMatchObject([{ from: { kind: 'note', body: 'Use v2 of the API.' }, why: 'unread' }]);
  });
});

describe('a note to a session that is not working', () => {
  it('starts no turn, and goes with its next turn', async () => {
    const w = await world();
    const turnsBefore = w.agents.turns.length;
    const result = await w.note(w.childA.id, w.childB.id, 'Branch is feature/oauth.');
    expect(result.text).toMatch(/is not working now\. It will get the note with its next turn; a note starts no turn\. If it should act on this now, send it as work with ask_session/);
    await w.settle();
    expect(w.agents.turns).toHaveLength(turnsBefore);
    expect(w.queue(w.childB.id)).toMatchObject([{ from: { kind: 'note' } }]);
    await w.runtime.reply(w.childB.id, 'carry on');
    await w.settle();
    const turn = w.agents.turns.at(-1)!;
    expect(turn.text).toMatch(/A note from the session "Child A".*Branch is feature\/oauth\.\n\ncarry on$/s);
    const messages = w.runtime.overlay(w.childB.id)!.messages;
    const at = messages.findIndex((m) => m.text === 'From Child A: Branch is feature/oauth.');
    expect(at).toBeGreaterThan(-1);
    expect(messages[at + 1]).toMatchObject({ author: 'you', text: 'carry on' });
    expect(w.queue(w.childB.id)).toEqual([]);
  });
});

describe('what a note may be', () => {
  it('is refused between sessions with no workstream or link between them, saying to send work instead', async () => {
    const w = await world();
    const result = await w.note(w.childA.id, w.stranger.id, 'hello');
    expect(result).toMatchObject({ isError: true, text: expect.stringMatching(/is not in this session's workstream and neither of you started the other.*ask_session/) });
    expect(w.queue(w.stranger.id)).toEqual([]);
  });

  it('is refused when longer than the limit, saying it is work', async () => {
    const w = await world();
    const result = await w.note(w.childA.id, w.childB.id, 'x'.repeat(NOTE_MAX + 1));
    expect(result).toMatchObject({ isError: true, text: expect.stringMatching(new RegExp(`a note is at most ${NOTE_MAX}\\. Anything longer is work: send it with ask_session`)) });
    expect((await w.note(w.childA.id, w.childB.id, 'x'.repeat(NOTE_MAX))).isError).toBeFalsy();
  });

  it('is refused when empty, to itself, or to a session that is not there', async () => {
    const w = await world();
    expect((await w.note(w.childA.id, w.childB.id, '  ')).text).toMatch(/The note is empty/);
    expect((await w.note(w.childA.id, w.childA.id, 'x')).text).toMatch(/That is this session/);
    expect((await w.note(w.childA.id, 'nope', 'x')).text).toMatch(/No such session: nope/);
  });

  it('counts against the per-pair limit together with ask_session, until the user writes to the sender', async () => {
    const w = await world();
    for (let i = 0; i < 3; i++) expect((await w.note(w.childA.id, w.childB.id, `n${i}`)).isError).toBeFalsy();
    expect((await w.note(w.childA.id, w.childB.id, 'n3')).text).toMatch(/You have sent "Child B" 3 messages since the user last wrote to you, which is the limit/);
    const ask = await w.runtime.delegation.hostFor(w.childA.id).askSession({ session: w.childB.id, message: 'do this' });
    expect(ask.text).toMatch(/which is the limit/);
    await w.runtime.reply(w.childA.id, 'go on');
    await w.settle();
    expect((await w.note(w.childA.id, w.childB.id, 'n4')).isError).toBeFalsy();
  });
});

describe('work held for a busy session', () => {
  it('keeps who sent it and the sender’s own words as data, while the model gets the whole framing', async () => {
    const w = await world();
    await w.busy(w.childB.id);
    await w.runtime.delegation.hostFor(w.childA.id).askSession({ session: w.childB.id, message: 'Rename foo to bar' });
    const [held] = w.queue(w.childB.id);
    expect(held).toMatchObject({ fromAgent: true, from: { sessionId: w.childA.id, title: 'Child A', body: 'Rename foo to bar', kind: 'work' } });
    expect(held!.text).toMatch(/^\[Kestrel\] The session "Child A" .* asks you to do this in your worktree/);
  });
});
