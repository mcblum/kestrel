// Kestrel Connect's dispatcher, end to end with no service: a fake phone sends frames, the real
// runtime carries them out, and what comes back is checked. The same tables run for Claude, Codex
// and OpenCode sessions alike, since Connect sits above the runtime and knows none of them.
// A phone is close to a screen share (Matt, 2026-11-22): what is in the chat window it can use.
import { mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, InputAnswer, InputRequest, KestrelToolHost } from '../agents/types.ts';
import { SELECTABLE_AGENTS, type Agent, type ChatMessage, type Project, type Session } from '../model.ts';
import { memoryPersistence } from '../persistence/memory.ts';
import { createProject } from '../project-store.ts';
import { ReviewReplies } from '../review-requests/reply.ts';
import { SessionRuntime } from '../runtime.ts';
import { ALWAYS_COMMAND, ALWAYS_FOLDER } from '../shared/sandbox-allow.ts';
import { MOVE_DECLINED } from '../shared/session-move.ts';
import { CONNECT_PROTOCOL_VERSION, NEVER_REMOTE, type ConnectResponse, type Envelope } from '../shared/connect-ops.ts';
import type { PullRequest } from '../shared/details.ts';
import { ready } from '../shared/sourced.ts';
import { openSuggestions } from '../shared/suggestions.ts';
import { FakeAgents, until } from '../test-agent.ts';
import { makeRepo } from '../test-repo.ts';
import { Workspace } from '../workspace.ts';
import { ConnectDispatcher, type ConnectPush } from './dispatcher.ts';

const MAC = 'mac-1';
const PHONE = 'phone-1';
/** A 1×1 PNG: what a phone's photo looks like to the attachment store. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let open: ConnectDispatcher[] = [];
afterEach(() => {
  for (const d of open) d.close();
  open = [];
});

/** A desktop with one fake agent per provider, one registered project, and a phone talking to it. */
async function desk() {
  const workspace = new Workspace(memoryPersistence());
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-connect-')));
  const fakes = Object.fromEntries(SELECTABLE_AGENTS.map((a) => [a, new FakeAgents()])) as Record<Agent, FakeAgents>;
  /** What each agent was answered, as the runtime passed it on. */
  const answered: InputAnswer[] = [];
  const adapters = Object.fromEntries(
    SELECTABLE_AGENTS.map((a): [Agent, AgentAdapter] => {
      const base = fakes[a].adapter();
      return [a, { ...base, agent: a, start: (o, p, e, att) => ({ ...base.start(o, p, e, att), answer: (_id, answer) => void answered.push(answer) }) }];
    }),
  );
  const runtime = new SessionRuntime(workspace, adapters, data);
  const project: Project = await createProject(workspace, { name: 'Shop' });
  const sent: Envelope<ConnectPush | ConnectResponse>[] = [];
  const dispatcher = new ConnectDispatcher({ workspace, runtime, deviceId: MAC, here: 'your Mac', send: (f) => sent.push(f) });
  open.push(dispatcher);
  let n = 0;
  /** The phone asks; the answer's body comes back. */
  const ask = async (op: string, args: Record<string, unknown> = {}): Promise<ConnectResponse> => {
    const answer = await dispatcher.receive({ v: CONNECT_PROTOCOL_VERSION, from: PHONE, to: MAC, kind: 'request', id: `q${++n}`, body: { op, args } });
    expect(answer).toMatchObject({ v: CONNECT_PROTOCOL_VERSION, from: MAC, to: PHONE, kind: 'response', replyTo: `q${n}` });
    return answer!.body;
  };
  const ok = async (op: string, args: Record<string, unknown> = {}): Promise<any> => {
    const body = await ask(op, args);
    if (!body.ok) throw new Error(`${op} refused: ${body.reason}`);
    return body.result;
  };
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      for (const f of Object.values(fakes)) await f.settled();
      for (const s of (await workspace.state()).sessions) await runtime.idle(s.id);
    }
  };
  const pushes = () => sent.filter((f): f is Envelope<ConnectPush> => f.kind === 'push');
  /** A session started at the desk: a phone does not start one. */
  const start = (agent: Agent, prompt = 'go', projectId: string | null = project.id) => runtime.start({ agent, projectId, prompt });
  /** The card waiting in a session, once it is there. */
  const waiting = async (sessionId: string) => {
    await until(() => runtime.overlay(sessionId)?.messages.some((m) => m.input && !m.input.resolved) ?? false, 'a card');
    return runtime.overlay(sessionId)!.messages.find((m) => m.input && !m.input.resolved)!.input!;
  };
  return { workspace, runtime, fakes, answered, project, dispatcher, sent, ask, ok, settle, pushes, start, waiting };
}
type Desk = Awaited<ReturnType<typeof desk>>;

describe.each(SELECTABLE_AGENTS)('every operation, for a %s session', (agent) => {
  it('reads, pages, watches, replies with a photo, answers, stops and marks seen', async () => {
    const d = await desk();
    const fake = d.fakes[agent];
    // First turn: says something. Second: asks for approval and waits.
    fake.script = (turn) => {
      if (turn.n === 1) return turn.emit({ type: 'message', id: `a${turn.n}`, text: 'on it', delta: 'on it', done: true });
      d.fakes[agent].hold = true;
      turn.emit({ type: 'needs-input', request: { id: 'ask-1', kind: 'approval', title: 'Run a command', detail: 'make', tool: 'Bash', options: [{ id: 'allow', label: 'Allow', role: 'allow' }, { id: 'deny', label: 'Deny', role: 'deny' }] } });
    };

    const session = await d.start(agent, 'fix the build');
    await d.settle();

    const state = await d.ok('state.read');
    expect(state).toEqual(await d.workspace.state());

    const first = await d.ok('session.read', { sessionId: session.id, last: 1 });
    expect(first.total).toBe(2);
    expect(first.messages.map((m: ChatMessage) => m.text)).toEqual(['on it']);
    const earlier = await d.ok('session.read', { sessionId: session.id, before: first.before, limit: 5 });
    expect(earlier.messages.map((m: ChatMessage) => m.text)).toEqual(['fix the build']);
    expect(earlier.before).toBeNull();

    expect(await d.ok('session.watch', { sessionId: session.id })).toEqual({ watching: true });
    const photo = await d.ok('session.attach', { draftId: 'draft-1', name: 'screen.png', mediaType: 'image/png', data: PNG });
    expect(await d.ok('session.reply', { sessionId: session.id, text: 'and this', draftId: 'draft-1', attachments: [photo.id] })).toEqual({ outcome: 'sent' });
    await d.settle();
    expect(fake.turns.at(-1)!.attachments).toHaveLength(1);

    // The card reaches the phone live, as the window shows it; the terminal-side panes do not.
    d.dispatcher.flush();
    expect(d.pushes().flatMap((p) => p.body.patch.messages ?? []).some((m) => m.input?.id === 'ask-1')).toBe(true);
    expect(d.pushes().every((p) => p.to === PHONE && p.body.patch.agentOutput === undefined && p.body.patch.commands === undefined)).toBe(true);
    const read = await d.ok('session.read', { sessionId: session.id });

    const sentPhoto = read.messages.find((m: ChatMessage) => m.attachments?.length).attachments[0];
    expect(await d.ok('attachment.read', { sessionId: session.id, attachmentId: sentPhoto.id })).toMatchObject({ type: 'image/png', data: PNG });

    expect(await d.ask('session.answer', { sessionId: session.id, requestId: 'ask-1', optionId: 'yes-please' })).toEqual({ ok: false, reason: "That is not one of the card's choices." });
    expect(await d.ok('session.answer', { sessionId: session.id, requestId: 'ask-1', optionId: 'allow' })).toEqual({ answered: true });
    expect(await d.ask('session.answer', { sessionId: session.id, requestId: 'ask-1', optionId: 'allow' })).toEqual({ ok: false, reason: 'That card is no longer waiting for an answer.' });

    expect(await d.ok('session.stop', { sessionId: session.id })).toEqual({ stopped: true });
    await d.settle();

    // Seen from the phone is seen everywhere: the one record the server keeps, not the window's ui-state.
    const pushed: unknown[] = [];
    d.workspace.seen.onChange((seen) => pushed.push(seen));
    await d.workspace.seen.markUnread(session.id);
    expect(await d.ok('session.seen', { sessionId: session.id })).toEqual({ seen: true });
    expect((await d.workspace.seen.view())[session.id]).toBeGreaterThan(0);
    expect(pushed).toHaveLength(2);
    expect(JSON.parse((await d.workspace.getUiState()) ?? '{}').seen).toBeUndefined();

    expect(await d.ok('session.unwatch', { sessionId: session.id })).toEqual({ watching: false });
    expect(await d.ask('media.read', { sessionId: session.id, name: 'nothing.png' })).toEqual({ ok: false, reason: 'That picture is no longer there.' });
  });

  it('refuses what a phone never does, starting a session among them', async () => {
    const d = await desk();
    const session = await d.start(agent, 'hello');
    await d.settle();
    for (const [op, reason] of Object.entries(NEVER_REMOTE)) expect(await d.ask(op, { sessionId: session.id })).toEqual({ ok: false, reason });
    expect(await d.ask('session.start', { projectId: d.project.id, prompt: 'go' })).toEqual({ ok: false, reason: NEVER_REMOTE['session.start'] });
    expect(NEVER_REMOTE['session.start']).toMatch(/^Sessions are started at the desk/);
    // No mode or model rides on a phone's message, Bypass least of all.
    expect(await d.ask('session.reply', { sessionId: session.id, text: 'go', permission: 'bypass' })).toEqual({ ok: false, reason: 'session.reply takes no permission.' });
    expect(await d.ask('session.read', { sessionId: 'nope' })).toEqual({ ok: false, reason: 'That session is no longer in Kestrel.' });
    expect(await d.ask('session.read', { sessionId: session.id, before: 'gone', limit: 5 })).toMatchObject({ ok: false, reason: expect.stringMatching(/no longer in the conversation/) });
    expect(await d.ask('session.attach', { draftId: 'd1', name: 'a.sh', mediaType: 'text/x-sh', data: 'ZWNobw==' })).toMatchObject({ ok: false, reason: expect.stringMatching(/Only photos/) });
    expect(await d.ask('session.attach', { draftId: '..', name: 'a.png', mediaType: 'image/png', data: PNG })).toMatchObject({ ok: false });
    expect((await d.workspace.state()).sessions).toHaveLength(1);
  });
});

// ---- every card, every choice ----------------------------------------------------------------

const folder = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-connect-allow-')));
const OPTIONS = {
  sandbox: [
    { id: 'allow', label: 'Allow', role: 'allow' },
    { id: ALWAYS_COMMAND, label: 'Always allow this command: make', role: 'allow' },
    { id: ALWAYS_FOLDER, label: 'Always allow this folder', role: 'allow' },
    { id: 'allow-outside', label: 'Allow all outside the sandbox', role: 'allow' },
    { id: 'deny', label: 'Deny', role: 'deny' },
  ],
  plan: [
    { id: 'approve-edits', label: 'Approve, accept edits', role: 'allow' },
    { id: 'approve-ask', label: 'Approve, ask before edits', role: 'allow' },
    { id: 'deny', label: 'Keep planning', role: 'deny' },
  ],
} as const;
/** The cards an agent raises, as each adapter builds them, with every choice on each. */
const AGENT_CARDS: { name: string; request: InputRequest; choices: InputAnswer[] }[] = [
  {
    name: 'a command outside the sandbox',
    request: { id: 'c1', kind: 'approval', tool: 'Bash', title: 'Run make (outside the sandbox)', detail: 'make', options: [...OPTIONS.sandbox], sandboxOffer: { command: ['make'], folder: { path: folder, access: 'read' } } },
    choices: OPTIONS.sandbox.map((o) => ({ optionId: o.id })),
  },
  {
    name: 'a plan',
    request: { id: 'c1', kind: 'approval', tool: 'ExitPlanMode', title: 'Plan', detail: '1. Do it', markdown: true, options: [...OPTIONS.plan] },
    choices: OPTIONS.plan.map((o) => ({ optionId: o.id })),
  },
  {
    name: 'a question',
    request: { id: 'c1', kind: 'question', tool: '', title: 'A question', detail: 'Which?', options: [], questions: [{ question: 'Which?', options: [{ label: 'This' }, { label: 'That' }] }] },
    choices: [{ answers: { 'Which?': 'That' } }, { text: 'Neither: something else' }],
  },
];

describe.each(SELECTABLE_AGENTS)('every card a %s agent raises, answered from a phone', (agent) => {
  for (const card of AGENT_CARDS) {
    it.each(card.choices)(`${card.name}: %o`, async (choice) => {
      const d = await desk();
      d.fakes[agent].hold = true;
      d.fakes[agent].script = (turn) => turn.emit({ type: 'needs-input', request: card.request });
      const session = await d.start(agent);
      await d.waiting(session.id);
      // The phone sees the card as the window does: every choice on it.
      const shown = (await d.ok('session.read', { sessionId: session.id })).messages.find((m: ChatMessage) => m.input?.id === 'c1').input;
      expect(shown.options).toEqual(card.request.options);
      expect(await d.ok('session.answer', { sessionId: session.id, requestId: 'c1', ...choice })).toEqual({ answered: true });
      // The agent is answered as from the desk: an "Always allow" adds the card's offer and allows.
      const always = choice.optionId === ALWAYS_COMMAND || choice.optionId === ALWAYS_FOLDER;
      expect(d.answered).toEqual([always ? { optionId: 'allow' } : choice]);
      const entries = await d.runtime.sandboxAllow.entries();
      if (choice.optionId === ALWAYS_COMMAND) expect(entries).toEqual([{ kind: 'command', words: ['make'] }]);
      else if (choice.optionId === ALWAYS_FOLDER) expect(entries).toEqual([{ kind: 'folder', path: folder, access: 'read' }]);
      else expect(entries).toEqual([]);
    });
  }
});

/** A session whose agent calls one of Kestrel's tools on its first turn, and the card that raises. */
async function asked(d: Desk, agent: Agent, use: (tools: KestrelToolHost) => Promise<unknown>, projectId: string | null) {
  let result: unknown;
  d.fakes[agent].script = async (turn) => {
    if (turn.n === 1) result = await use(turn.options.tools);
  };
  const session = await d.start(agent, 'go', projectId);
  const card = await d.waiting(session.id);
  return { session, card, result: () => result };
}

describe.each(SELECTABLE_AGENTS)("Kestrel's own cards in a %s session, answered from a phone", (agent) => {
  it.each(['allow', 'deny'])('add_project: %s', async (optionId) => {
    const d = await desk();
    const { session, card, result } = await asked(d, agent, (t) => t.addProject({ path: makeRepo(), name: 'Found' }), d.project.id);
    expect(await d.ok('session.answer', { sessionId: session.id, requestId: card.id, optionId })).toEqual({ answered: true });
    await until(() => result() !== undefined, 'the tool to return');
    const names = (await d.workspace.state()).projects.map((p) => p.name);
    expect(names.includes('Found')).toBe(optionId === 'allow');
  });

  it.each(['allow', 'deny'])('move_to_project: %s', async (optionId) => {
    const d = await desk();
    await createProject(d.workspace, { name: 'Repo', folders: [makeRepo()] });
    const { session, card, result } = await asked(d, agent, (t) => t.moveToProject({ project: 'Repo' }), null);
    expect(await d.ok('session.answer', { sessionId: session.id, requestId: card.id, optionId })).toEqual({ answered: true });
    await until(() => result() !== undefined, 'the tool to return');
    const said = (result() as { text: string }).text;
    if (optionId === 'allow') expect(said).not.toBe(MOVE_DECLINED);
    else expect(said).toBe(MOVE_DECLINED);
  });

  it.each(['allow', 'deny'])('spawn: %s', async (optionId) => {
    const d = await desk();
    const { session, card, result } = await asked(d, agent, (t) => t.spawn({ project: 'Shop', brief: 'look into it' }), d.project.id);
    expect(await d.ok('session.answer', { sessionId: session.id, requestId: card.id, optionId })).toEqual({ answered: true });
    await until(() => result() !== undefined, 'the tool to return');
    expect((await d.workspace.state()).sessions).toHaveLength(optionId === 'allow' ? 2 : 1);
  });

  it('next_step: the phone reads the card and sends one of its replies', async () => {
    const d = await desk();
    d.fakes[agent].script = async (turn) => {
      if (turn.n === 1) await turn.options.tools.nextStep({ recap: 'Done the first half.', ask: 'Go on?', replies: ['Yes, go on'] });
    };
    const session = await d.start(agent);
    await d.settle();
    const next = (await d.ok('session.read', { sessionId: session.id })).messages.find((m: ChatMessage) => m.next)?.next;
    expect(next).toMatchObject({ ask: 'Go on?', replies: ['Yes, go on'] });
    expect(await d.ok('session.reply', { sessionId: session.id, text: next.replies[0] })).toEqual({ outcome: 'sent' });
    await d.settle();
    expect(d.fakes[agent].turns.at(-1)!.text).toBe('Yes, go on');
  });
});

// ---- posting a review --------------------------------------------------------------------------

describe.each(SELECTABLE_AGENTS)('a suggestion card answered from a phone, for a %s session', (agent) => {
  /** A session whose agent suggested a tag on its first turn: the card waits in the conversation. */
  async function suggested(d: Desk) {
    d.fakes[agent].script = async (turn) => {
      await turn.options.tools.suggest({ kind: 'tag', tag: 'PROJ-482', category: 'ticket', source: 'Jira', reason: 'The task names PROJ-482.' } as never);
    };
    const session = await d.start(agent, 'Fix the upload hang for PROJ-482');
    await d.settle();
    const [card] = openSuggestions(d.runtime.recordOf(session.id)!.messages);
    return { sessionId: session.id, card: card! };
  }

  it('answers a button and undoes it, as the desk does', async () => {
    const d = await desk();
    const { sessionId, card } = await suggested(d);
    const answered = await d.ok('suggestion.answer', { sessionId, suggestionId: card.id, button: 'tag' });
    expect(answered.suggestion).toMatchObject({ id: card.id, state: 'answered', answer: 'tag' });
    expect((await d.workspace.state()).sessions.find((s) => s.id === sessionId)!.tags).toContain('PROJ-482');
    expect(await d.ask('suggestion.answer', { sessionId, suggestionId: card.id, button: 'tag' })).toMatchObject({ ok: false, reason: expect.any(String) });
    const undone = await d.ok('suggestion.undo', { sessionId, suggestionId: card.id });
    expect(undone.suggestion.undo).toBeUndefined();
    expect((await d.workspace.state()).sessions.find((s) => s.id === sessionId)!.tags).not.toContain('PROJ-482');
    expect(await d.ask('suggestion.undo', { sessionId, suggestionId: card.id })).toEqual({ ok: false, reason: 'There is nothing to undo there.' });
  });

  it('dismisses with the x, and refuses a card or session that is not there', async () => {
    const d = await desk();
    const { sessionId, card } = await suggested(d);
    expect((await d.ok('suggestion.dismiss', { sessionId, suggestionId: card.id })).suggestion).toMatchObject({ state: 'dismissed' });
    expect(await d.ask('suggestion.dismiss', { sessionId: 'gone', suggestionId: card.id })).toEqual({ ok: false, reason: 'That session is no longer in Kestrel.' });
    expect(await d.ask('suggestion.answer', { sessionId, suggestionId: 'nope', button: 'tag' })).toMatchObject({ ok: false, reason: expect.any(String) });
  });
});

describe('a review card posted from a phone', () => {
  const SHA = 'a'.repeat(40);
  /** The runtime's ReviewReplies, over a host whose pull request is at `head`: gh and glab are never called. */
  async function reviewDesk(head: string) {
    const d = await desk();
    const calls: string[][] = [];
    let messages: ChatMessage[] = [];
    const session = { id: 'r1', startedIn: d.project.id, worktreePath: '/w', worktreeDiscarded: false, review: { key: 'k', host: 'github', number: 12, sha: SHA, url: 'u' } } as Session;
    const replies = new ReviewReplies({
      session: async (id) => (id === 'r1' ? session : undefined),
      messages: () => messages,
      showCard: (_id, card) => void (messages = [...messages.filter((m) => m.id !== card.id), { id: card.id, author: 'agent', time: '', text: '', review: card.review } as ChatMessage]),
      notice: () => undefined,
      settings: async () => ({ mode: 'list', projects: 'all' }),
      byNumber: () => ({ pullRequestByNumber: async () => ready({ number: 12, state: 'open', headSha: head } as PullRequest) }),
      run: async (_bin, args) => (calls.push([...args]), { stdout: '' }),
      now: () => 1000,
    });
    Object.defineProperty(d.runtime, 'reviewReplies', { value: replies });
    await replies.hostFor('r1').postReview({ verdict: 'approve', summary: 'Good.', findings: [{ brief: 'Nit.', priority: 'low', blocking: false }] });
    return { ...d, calls, cardId: messages[0]!.id };
  }

  it('posts it with the edits made on the phone, as Post does at the desk', async () => {
    const d = await reviewDesk(SHA);
    const result = await d.ok('review.post', { sessionId: 'r1', cardId: d.cardId, verdict: 'comment', summary: 'Edited on the phone.' });
    expect(result.review).toMatchObject({ verdict: 'comment', summary: 'Edited on the phone.', posted: { verdict: 'comment' } });
    expect(d.calls).toHaveLength(1);
    expect(await d.ask('review.post', { sessionId: 'r1', cardId: d.cardId })).toEqual({ ok: false, reason: 'This review was already posted.' });
  });

  it('never posts an approval for a commit other than the one reviewed', async () => {
    const d = await reviewDesk('b'.repeat(40));
    expect(await d.ask('review.post', { sessionId: 'r1', cardId: d.cardId })).toMatchObject({ ok: false, reason: expect.stringMatching(/new commits since this review/) });
    expect(d.calls).toEqual([]);
  });

  it('gives the desk\'s reasons for edits it cannot use', async () => {
    const d = await reviewDesk(SHA);
    expect(await d.ask('review.post', { sessionId: 'r1', cardId: d.cardId, verdict: 'lgtm' })).toMatchObject({ ok: false, reason: expect.stringMatching(/verdict must be one of/) });
    expect(await d.ask('review.post', { sessionId: 'r1', cardId: d.cardId, verdict: 'comment', withoutComment: true })).toMatchObject({ ok: false, reason: expect.stringMatching(/Only an approval/) });
    expect(await d.ask('review.post', { sessionId: 'r1', cardId: 'nope' })).toEqual({ ok: false, reason: 'There is no such review in this session.' });
    expect(d.calls).toEqual([]);
  });
});

describe('frames', () => {
  it('answers a frame of another version, or for another device, with the reason', async () => {
    const d = await desk();
    const newer = await d.dispatcher.receive({ v: CONNECT_PROTOCOL_VERSION + 1, from: PHONE, to: MAC, kind: 'request', id: 'x1', body: { op: 'state.read' } });
    expect(newer?.body).toEqual({ ok: false, reason: expect.stringMatching(/^Update Kestrel on your Mac/) });
    const elsewhere = await d.dispatcher.receive({ v: CONNECT_PROTOCOL_VERSION, from: PHONE, to: 'mac-2', kind: 'request', id: 'x2', body: { op: 'state.read' } });
    expect(elsewhere?.body).toEqual({ ok: false, reason: 'That was meant for another device, not your Mac.' });
    const push = await d.dispatcher.receive({ v: CONNECT_PROTOCOL_VERSION, from: PHONE, to: MAC, kind: 'push', id: 'x3', body: {} });
    expect(push?.body).toMatchObject({ ok: false });
  });

  it('answers a malformed frame it can address, and drops one it cannot', async () => {
    const d = await desk();
    expect((await d.dispatcher.receive({ from: PHONE, id: 'x1', kind: 'request' }))?.body).toMatchObject({ ok: false, reason: expect.stringMatching(/protocol version/) });
    expect(await d.dispatcher.receive({ v: 1, kind: 'request' })).toBeNull();
    expect(await d.dispatcher.receive('garbage')).toBeNull();
  });

  it('stops pushing to a device that said bye', async () => {
    const d = await desk();
    d.fakes.claude.script = (turn) => turn.emit({ type: 'message', id: `a${turn.n}`, text: `turn ${turn.n}`, delta: '', done: true });
    const session = await d.start('claude');
    await d.settle();
    await d.ok('session.watch', { sessionId: session.id });
    await d.dispatcher.receive({ v: CONNECT_PROTOCOL_VERSION, from: PHONE, to: MAC, kind: 'bye', id: 'b1', body: null });
    await d.ok('session.reply', { sessionId: session.id, text: 'again' });
    await d.settle();
    d.dispatcher.flush();
    expect(d.pushes()).toEqual([]);
  });
});

describe('the dispatcher stays in process', () => {
  it('imports no listener, socket or HTTP route, and nothing from security.ts', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      const source = readFileSync(join(here, file), 'utf8');
      expect(source).not.toMatch(/from '(node:)?(http|https|net)'|from '\.\.\/(http|security|kestrel-mcp)\.ts'|from 'ws'/);
    }
  });
});
