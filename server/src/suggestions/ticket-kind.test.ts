// The `ticket` suggestion end to end, through a real runtime with a scripted agent and the sample
// tracker: the `ticket_update` tool, each button, the standing answers, Undo, that it never blocks,
// Kestrel's own In progress proposal, and the refusals. No test reaches a real tracker.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolResult } from '../agents/types.ts';
import { memoryPersistence } from '../persistence/memory.ts';
import { SessionRuntime } from '../runtime.ts';
import { openSuggestions, suggestionsIn, type Suggestion } from '../shared/suggestions.ts';
import { asTicketAnswers, standingAnswer, withTicketAnswer } from '../shared/ticket-changes.ts';
import { FakeAgents } from '../test-agent.ts';
import { sessionTickets } from '../tickets/session.ts';
import { fakeTicketSource } from '../tickets/sources/fake.ts';
import { TicketStore } from '../tickets/store.ts';
import { syncTickets } from '../tickets/sync.ts';
import { Workspace } from '../workspace.ts';
import { SHOWN_TEXT } from './service.ts';
import { TICKET_WORK_KIND } from './ticket-work-kind.ts';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const KEY = 'fake:BELL-139';

async function world(opts: { on?: boolean; attach?: boolean; connected?: boolean } = {}) {
  const db = memoryPersistence();
  const workspace = new Workspace(db);
  const agents = new FakeAgents();
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-ticket-kind-')));
  const runtime = new SessionRuntime(workspace, { claude: agents.adapter() }, data, { suggestions: { settings: db } });
  const store = new TicketStore({ settings: { on: opts.on ?? true, off: [], show: 'page' as const } });
  const source = fakeTicketSource(() => NOW);
  const sync = syncTickets(async () => [source], store, () => true, () => NOW, false);
  await sync.check();
  const connected = opts.connected ?? true;
  runtime.useTickets(sessionTickets({ store, sync: { read: sync.read, sourceOf: async (t) => (connected ? sync.sourceOf(t) : null) }, workstreams: async () => (await workspace.state()).workstreams, liveSessions: async () => new Set((await workspace.state()).sessions.map((s) => s.id)), tag: (id, tag) => workspace.tagSession(id, tag), untag: (id, tag) => workspace.untagSession(id, tag) }));
  const results: ToolResult[] = [];
  let calls: Record<string, unknown>[] = [];
  agents.script = async (turn) => {
    prompts.push(turn.text);
    for (const args of calls) results.push(await (args.read ? turn.options.tools.ticketRead(typeof args.read === 'string' ? { key: args.read } : undefined) : turn.options.tools.ticketUpdate(args as never)));
  };
  const session = await runtime.start({ agent: 'claude', projectId: null, prompt: 'Work BELL-139' });
  await agents.settled();
  await runtime.idle(session.id);
  if (opts.attach ?? true) store.attach({ ticketKey: KEY, attachedTo: 'session', id: session.id, role: 'lead', at: NOW });
  const prompts: string[] = [];
  const turn = async (next: Record<string, unknown>[], text = 'Go on') => {
    calls = next;
    results.length = 0;
    await runtime.reply(session.id, text);
    await agents.settled();
    await runtime.idle(session.id);
    return [...results];
  };
  const suggestions = (): Suggestion[] => suggestionsIn(runtime.recordOf(session.id)?.messages ?? []);
  const status = () => store.ticket(KEY)!.status.name;
  return { db, workspace, prompts, session, runtime, agents, store, id: session.id, turn, suggestions, status };
}

describe('the ticket suggestion', () => {
  it('shows a card without pausing the turn, with Allow, Allow always, Deny and Don’t ask again', async () => {
    const w = await world();
    expect(await w.turn([{ change: 'in-progress', reason: 'Starting on it.' }])).toEqual([{ text: SHOWN_TEXT }]);
    const [card] = openSuggestions(w.runtime.recordOf(w.id)!.messages);
    expect(card).toMatchObject({ kind: 'ticket', title: 'Move BELL-139 to In progress?', reason: 'Starting on it.', state: 'open' });
    expect(card!.buttons.map((b) => b.label)).toEqual(['Allow', 'Allow always', 'Deny', 'Don’t ask again']);
    expect(w.status()).toBe('To Do'); // nothing moved until the user says so
    expect((await w.workspace.state()).sessions.find((s) => s.id === w.id)!.state).toBe('done'); // never waits on the user
  });

  it('Allow moves the ticket through the tracker and offers Undo, which moves it back', async () => {
    const w = await world();
    await w.turn([{ change: 'in-progress' }]);
    const answered = await w.runtime.suggestions.answer(w.id, w.suggestions()[0]!.id, 'allow');
    expect(answered).toMatchObject({ state: 'answered', line: 'Moved BELL-139 to In Progress', undo: { from: 'To Do' } });
    expect(w.status()).toBe('In Progress');
    const undone = await w.runtime.suggestions.undo(w.id, answered.id);
    expect(undone.line).toBe('Moved BELL-139 back to To Do');
    expect(w.status()).toBe('To Do');
  });

  it('Deny and the × leave the ticket; Don’t ask again keeps that answer and later proposals are skipped', async () => {
    const w = await world();
    await w.turn([{ change: 'in-progress' }]);
    expect(await w.runtime.suggestions.dismiss(w.id, w.suggestions()[0]!.id)).toMatchObject({ state: 'dismissed', answer: 'deny', line: 'Left BELL-139 as it is' });
    await w.turn([{ change: 'in-review' }]);
    const never = await w.runtime.suggestions.answer(w.id, w.suggestions().at(-1)!.id, 'never');
    expect(never.state).toBe('dismissed');
    expect(w.status()).toBe('To Do');
    expect(standingAnswer(await w.runtime.suggestions.prefs.ticketAnswers(), 'in-review', 'fake')).toBe('never');
    const [skipped] = await w.turn([{ change: 'in-review' }]);
    expect(skipped!.text).toContain('chose not to be asked');
    expect(openSuggestions(w.runtime.recordOf(w.id)!.messages)).toHaveLength(0);
  });

  it('Allow always moves now, and the next such change is made without asking, said in the conversation with Undo', async () => {
    const w = await world();
    await w.turn([{ change: 'in-progress' }]);
    await w.runtime.suggestions.answer(w.id, w.suggestions()[0]!.id, 'always');
    expect(w.status()).toBe('In Progress');
    await w.runtime.suggestions.prefs.setTicketAnswer('in-review', 'sample', 'always');
    const [result] = await w.turn([{ change: 'in-review' }]);
    expect(result!.text).toContain('Done without asking');
    const auto = w.suggestions().at(-1)!;
    expect(auto).toMatchObject({ auto: true, state: 'answered', line: 'Moved BELL-139 to In Review', undo: { from: 'In Progress' } });
    expect(w.status()).toBe('In Review');
    await w.runtime.suggestions.undo(w.id, auto.id);
    expect(w.status()).toBe('In Progress');
  });

  it('a comment is added on Allow, with no Undo', async () => {
    const w = await world();
    await w.turn([{ change: 'comment', body: 'Opened a pull request for this.' }]);
    const card = w.suggestions()[0]!;
    expect(card).toMatchObject({ title: 'Add this comment to BELL-139?', detail: 'Opened a pull request for this.' });
    expect(card.reason).toBeUndefined();
    const answered = await w.runtime.suggestions.answer(w.id, card.id, 'allow');
    expect(answered).toMatchObject({ line: 'Commented on BELL-139' });
    expect(answered.undo).toBeUndefined();
  });

  it('is not proposed for a ticket already there or further', async () => {
    const w = await world();
    await w.runtime.suggestions.prefs.setTicketAnswer('in-review', 'sample', 'always');
    await w.turn([{ change: 'in-review' }]);
    const [skipped] = await w.turn([{ change: 'in-progress' }]);
    expect(skipped!.text).toContain('already In Review');
  });

  it('Kestrel proposes In progress when work starts, once', async () => {
    const w = await world();
    expect(await w.runtime.proposeTicketStarted(w.id)).toEqual({ text: SHOWN_TEXT });
    expect((await w.runtime.proposeTicketStarted(w.id)).text).toContain('already been asked');
    expect(openSuggestions(w.runtime.recordOf(w.id)!.messages)).toHaveLength(1);
  });

  it('refuses what it cannot do, with the reason', async () => {
    const w = await world();
    const [bad, empty] = await w.turn([{ change: 'done' }, { change: 'comment', body: ' ' }]);
    expect(bad).toMatchObject({ isError: true, text: expect.stringContaining('Nothing else about a ticket') });
    expect(empty).toMatchObject({ isError: true, text: expect.stringContaining('Give the comment') });
    expect((await (await world({ attach: false })).turn([{ change: 'in-progress' }]))[0]).toMatchObject({ isError: true, text: expect.stringContaining('has no ticket') });
    expect((await (await world({ on: false })).turn([{ change: 'in-progress' }]))[0]).toMatchObject({ isError: true, text: expect.stringContaining('Tickets are off') });
    expect((await (await world({ connected: false })).turn([{ change: 'in-progress' }]))[0]).toMatchObject({ isError: true, text: expect.stringContaining('not connected') });
  });
});

describe('ticket_read', () => {
  it('gives the ticket as the tracker has it, and refuses without one', async () => {
    const w = await world();
    const [read] = await w.turn([{ read: true }]);
    expect(read!.text).toContain('# BELL-139');
    expect(read!.text).toContain('Status: To Do');
    const none = await world({ attach: false });
    expect((await none.turn([{ read: true }]))[0]).toMatchObject({ isError: true });
  });

  it('reads a listed ticket named by its key without attaching it, and refuses a key Kestrel does not list', async () => {
    const w = await world({ attach: false });
    const [byRef, byKey, unknown] = await w.turn([{ read: 'docs-77' }, { read: 'fake:PLAT-318' }, { read: 'NOPE-9' }]);
    expect(byRef!.text).toContain('# DOCS-77');
    expect(byKey!.text).toContain('# PLAT-318');
    expect(unknown).toMatchObject({ isError: true });
    expect(unknown!.text).toContain('Kestrel does not list NOPE-9');
    expect(w.store.view().links).toEqual([]);
  });
});

describe('the standing answers', () => {
  it('are kept one per change and source, in order, and set back to Ask', () => {
    const answers = withTicketAnswer(withTicketAnswer([], 'comment', 'jira', 'never'), 'in-progress', 'jira', 'always');
    expect(answers.map((a) => a.change)).toEqual(['in-progress', 'comment']);
    expect(standingAnswer(answers, 'in-progress', 'jira')).toBe('always');
    expect(standingAnswer(answers, 'in-progress', 'gitlab@host')).toBeNull();
    expect(withTicketAnswer(answers, 'comment', 'jira', null)).toHaveLength(1);
    expect(asTicketAnswers([{ change: 'done', source: 'jira', answer: 'always' }, { change: 'comment', source: 'nope', answer: 'never' }, ...answers])).toEqual(answers);
  });
});

describe('a ticket named in the user’s message', () => {
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it('is taken up as Work this ticket does: attached, tagged, given to the agent with that turn, said with Undo, and In progress proposed', async () => {
    const w = await world({ attach: false });
    await w.turn([], 'Please pick up BELL-139 next');
    await settle();
    expect(w.store.view().links).toMatchObject([{ ticketKey: KEY, attachedTo: 'session', id: w.id }]);
    expect((await w.workspace.state()).sessions.find((s) => s.id === w.id)!.tags).toContain('BELL-139');
    expect(w.prompts.at(-1)).toContain('# BELL-139');
    expect(w.prompts.at(-1)).toContain('Please pick up BELL-139 next');
    const line = w.suggestions().find((s) => s.kind === TICKET_WORK_KIND)!;
    expect(line).toMatchObject({ state: 'answered', auto: true, line: 'Working on BELL-139 in this session' });
    expect(openSuggestions(w.runtime.recordOf(w.id)!.messages)).toMatchObject([{ kind: 'ticket', title: 'Move BELL-139 to In progress?' }]);
    await w.runtime.suggestions.undo(w.id, line.id);
    expect(w.store.view().links).toEqual([]);
    expect((await w.workspace.state()).sessions.find((s) => s.id === w.id)!.tags ?? []).not.toContain('BELL-139');
  });

  it('under Allow always, moves it at once and says so with Undo; under Don’t ask again, only attaches', async () => {
    const w = await world({ attach: false });
    await w.runtime.suggestions.prefs.setTicketAnswer('in-progress', 'sample', 'always');
    await w.turn([], 'BELL-139');
    await settle();
    expect(w.status()).toBe('In Progress');
    expect(w.suggestions().at(-1)).toMatchObject({ kind: 'ticket', auto: true, line: 'Moved BELL-139 to In Progress' });
    const n = await world({ attach: false });
    await n.runtime.suggestions.prefs.setTicketAnswer('in-progress', 'sample', 'never');
    await n.turn([], 'BELL-139');
    await settle();
    expect(n.status()).toBe('To Do');
    expect(n.suggestions().filter((s) => s.kind === 'ticket')).toEqual([]);
  });

  it('leaves a session that has a ticket with it, and an agent cannot raise it', async () => {
    const w = await world();
    await w.turn([], 'and DOCS-77 while you are at it');
    expect(w.store.view().links.map((l) => l.ticketKey)).toEqual([KEY]);
    expect(w.suggestions().filter((s) => s.kind === TICKET_WORK_KIND)).toEqual([]);
    const tools = w.runtime.toolsFor(w.id)!.host;
    expect(await tools.suggest({ kind: TICKET_WORK_KIND, mode: 'attach', key: 'fake:DOCS-77', ref: 'DOCS-77' })).toMatchObject({ isError: true });
  });

  it('names the session a ticket is under way in, with a link, and attaches nothing', async () => {
    const w = await world({ attach: false });
    w.store.attach({ ticketKey: KEY, attachedTo: 'session', id: 'elsewhere', role: 'lead', at: NOW });
    const other = await w.runtime.start({ agent: 'claude', projectId: null, prompt: 'Other work' });
    await w.agents.settled();
    await w.runtime.idle(other.id);
    w.store.attach({ ticketKey: KEY, attachedTo: 'session', id: other.id, role: 'lead', at: NOW });
    await w.turn([], 'BELL-139');
    expect(w.suggestions().find((s) => s.kind === TICKET_WORK_KIND)).toMatchObject({ opens: other.id, line: expect.stringContaining('is under way in') });
    expect(w.store.view().links.filter((l) => l.id === w.id)).toEqual([]);
  });

  it('offers a pick for several, which never blocks; the one picked is attached and given to the agent next turn', async () => {
    const w = await world({ attach: false });
    await w.turn([], 'BELL-139 or DOCS-77?');
    expect(w.store.view().links).toEqual([]);
    const card = openSuggestions(w.runtime.recordOf(w.id)!.messages)[0]!;
    expect(card.buttons.map((b) => b.label)).toEqual(['BELL-139', 'DOCS-77', 'None']);
    const picked = await w.runtime.suggestions.answer(w.id, card.id, card.buttons.find((b) => b.label === 'DOCS-77')!.id);
    expect(picked.line).toBe('Working on DOCS-77 in this session');
    await settle();
    expect(w.store.view().links).toMatchObject([{ ticketKey: 'fake:DOCS-77', id: w.id }]);
    await w.turn([]);
    expect(w.prompts.at(-1)).toContain('# DOCS-77');
  });

  it('a card still asking to tag the session with the key picked has its answer once the pick tags it', async () => {
    const w = await world({ attach: false });
    await w.turn([], 'BELL-139 or DOCS-77?');
    expect((await w.runtime.suggestions.suggest(w.id, { kind: 'tag', tag: 'DOCS-77', category: 'ticket', source: 'jira' })).text).toBe(SHOWN_TEXT);
    const pick = openSuggestions(w.runtime.recordOf(w.id)!.messages).find((s) => s.kind === TICKET_WORK_KIND)!;
    await w.runtime.suggestions.answer(w.id, pick.id, pick.buttons.find((b) => b.label === 'DOCS-77')!.id);
    await settle();
    const tagCard = w.suggestions().find((s) => s.kind === 'tag')!;
    expect(tagCard).toMatchObject({ state: 'expired', line: 'Tagged DOCS-77' });
    expect(openSuggestions(w.runtime.recordOf(w.id)!.messages).map((s) => s.kind)).toEqual(['ticket']);
  });

  it('a new session the user starts takes up the ticket its first message names', async () => {
    const w = await world({ attach: false });
    const fresh = await w.runtime.start({ agent: 'claude', projectId: null, prompt: 'Fix BELL-139', byUser: true });
    await w.agents.settled();
    await w.runtime.idle(fresh.id);
    expect(w.store.view().links).toMatchObject([{ ticketKey: KEY, id: fresh.id }]);
    expect(w.prompts.at(-1)).toContain('# BELL-139');
  });
});

describe('the moments Kestrel proposes a change itself', () => {
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const pr = (n: number) => ({ host: 'gitlab' as const, number: n, url: `https://git.example.test/team/app/-/merge_requests/${n}`, branch: 'kestrel/work', state: 'open' as const });
  const ticketCards = (w: Awaited<ReturnType<typeof world>>) => w.suggestions().filter((s) => s.kind === 'ticket');

  it('a pull request opened proposes a comment with its link and In review, once for that request', async () => {
    const w = await world();
    await w.workspace.recordRequests(w.id, [pr(1)]);
    await settle();
    const cards = ticketCards(w);
    expect(cards.map((c) => [c.payload.change, c.payload.body ?? null])).toEqual([
      ['comment', `Pull request: ${pr(1).url}`],
      ['in-review', null],
    ]);
    for (const c of cards) await w.runtime.suggestions.answer(w.id, c.id, 'deny');
    // The same request again (seen in another state) proposes nothing; Kestrel never moves it to done.
    await w.workspace.recordRequests(w.id, [{ ...pr(1), state: 'merged' }]);
    expect((await w.runtime.suggestions.suggest(w.id, { kind: 'ticket', change: 'in-review', once: `pr:${pr(1).url}` })).text).toContain('proposed once already');
    await settle();
    expect(ticketCards(w)).toHaveLength(2);
    // Another request is its own moment.
    await w.workspace.recordRequests(w.id, [pr(2)]);
    await settle();
    expect(ticketCards(w)).toHaveLength(4);
  });

  it('a session without a ticket gets nothing when its request opens', async () => {
    const w = await world({ attach: false });
    await w.workspace.recordRequests(w.id, [pr(1)]);
    await settle();
    expect(ticketCards(w)).toEqual([]);
  });

  it('the lead finishing at a pull request proposes a comment with its report, once', async () => {
    const w = await world();
    w.agents.script = async (turn) => {
      turn.emit({ type: 'message', id: `m${turn.n}`, text: 'Done: the cart waits for typing to settle. Pull request opened.', delta: '', done: true });
    };
    await w.turn([]);
    expect(ticketCards(w).filter((c) => c.payload.once === 'finished')).toEqual([]); // no pull request yet
    await w.workspace.recordRequests(w.id, [pr(3)]);
    await w.turn([]);
    await settle();
    const summary = ticketCards(w).filter((c) => c.payload.once === 'finished');
    expect(summary).toHaveLength(1);
    expect(summary[0]!.payload.body).toBe('Done: the cart waits for typing to settle. Pull request opened.');
    await w.runtime.suggestions.answer(w.id, summary[0]!.id, 'deny');
    await w.turn([]);
    await settle();
    expect(ticketCards(w).filter((c) => c.payload.once === 'finished')).toHaveLength(1);
  });
});
