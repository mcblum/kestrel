// Kestrel Connect's dispatcher, end to end with no service: a fake phone sends frames, the real
// runtime carries them out, and what comes back is checked. The same tables run for Claude, Codex
// and OpenCode sessions alike, since Connect sits above the runtime and knows none of them.
// A phone is close to a screen share (Matt, 2026-11-22): what is in the chat window it can use.
import { mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, InputAnswer, ModelOption, InputRequest, KestrelToolHost } from '../agents/types.ts';
import { AGENT_LABEL, SELECTABLE_AGENTS, type Agent, type ChatMessage, type Project, type Session } from '../model.ts';
import { memoryPersistence } from '../persistence/memory.ts';
import { createProject } from '../project-store.ts';
import { ReviewReplies } from '../review-requests/reply.ts';
import { SessionRuntime } from '../runtime.ts';
import { ALWAYS_COMMAND, ALWAYS_FOLDER } from '../shared/sandbox-allow.ts';
import { MOVE_DECLINED } from '../shared/session-move.ts';
import { ASIDE_REFUSAL, BYPASS_FROM_ELSEWHERE, CONNECT_PROTOCOL_VERSION, NEVER_REMOTE, type ConnectResponse, type Envelope } from '../shared/connect-ops.ts';
import type { PullRequest } from '../shared/details.ts';
import { ready } from '../shared/sourced.ts';
import { openSuggestions } from '../shared/suggestions.ts';
import { COMPACTION, FakeAgents, until } from '../test-agent.ts';
import type { ContextUsage } from '../shared/context-usage.ts';
import { makeRepo } from '../test-repo.ts';
import { Workspace } from '../workspace.ts';
import { ConnectDispatcher, type ConnectDeps, type ConnectPush } from './dispatcher.ts';
import { ReviewRequestStore } from '../review-requests/store.ts';
import type { StartReviewOptions } from '../review-requests/start.ts';
import { TicketStore } from '../tickets/store.ts';
import { syncTickets } from '../tickets/sync.ts';
import type { TicketSource } from '../tickets/source.ts';
import { remoteStartsOff } from '../remote-starts/prefs.ts';
import { MODEL_WITHOUT_AGENT, noSuchPreset, notAModel } from '../remote-starts/session-start.ts';
import { connectLists, PULL_REQUESTS_LOOK_MS } from './lists.ts';
import { PullRequestStore } from '../pull-requests/store.ts';
import { DEFAULT_ATTENTION_PREFS } from '../shared/request-attention.ts';
import { REQUEST_KIND } from '../suggestions/request-kind.ts';
import { ARCHIVE_KIND } from '../shared/archive-approved.ts';
import { reviewRequestKey } from '../shared/review-requests.ts';
import { FINDING_ACTIONS } from '../finding-actions.ts';
import { REVIEW_END_ACTIONS } from '../review-end.ts';
import type { RoundFindings } from '../shared/round-findings.ts';
import { NO_REVIEW_REQUESTS, type ReviewRequest, type ReviewRequestsView } from '../shared/review-requests.ts';
import { REVIEWS_OFF_REASON } from '../shared/review-settings.ts';
import { NO_TICKETS, TICKETS_OFF_REASON, type Ticket, type TicketsView } from '../shared/tickets.ts';

type LivePush = Extract<ConnectPush, { type: 'live' }>;

/** A store as the dispatcher sees one: its view, and a change heard by whoever listens. */
class FakeStore<T> {
  private readonly listeners = new Set<(view: T) => void>();
  constructor(private current: T) {}
  view(): T {
    return this.current;
  }
  set(view: T): void {
    this.current = view;
    for (const l of this.listeners) l(view);
  }
  onChange(listener: (view: T) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

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
async function desk(extra: (workspace: Workspace, runtime: SessionRuntime) => Partial<ConnectDeps> = () => ({})) {
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
  const reviewStore = new FakeStore<ReviewRequestsView>(NO_REVIEW_REQUESTS);
  const ticketStore = new FakeStore<TicketsView>(NO_TICKETS);
  const lists = connectLists(runtime.reviewPrefs, reviewStore, ticketStore);
  const dispatcher = new ConnectDispatcher({ workspace, runtime, deviceId: MAC, here: 'your Mac', send: (f) => sent.push(f), lists, keptOff: () => [], ...extra(workspace, runtime) });
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
  /** Live output pushed to a phone. */
  const pushes = () => sent.filter((f): f is Envelope<LivePush> => f.kind === 'push' && (f.body as ConnectPush).type === 'live');
  /** The Code reviews and Tickets lists pushed to a device. */
  const listPushes = () => sent.filter((f): f is Envelope<ConnectPush> => f.kind === 'push' && (f.body as ConnectPush).type !== 'live');
  /** A session started at the desk: a phone does not start one. */
  const start = (agent: Agent, prompt = 'go', projectId: string | null = project.id) => runtime.start({ agent, projectId, prompt });
  /** The card waiting in a session, once it is there. */
  const waiting = async (sessionId: string) => {
    await until(() => runtime.overlay(sessionId)?.messages.some((m) => m.input && !m.input.resolved) ?? false, 'a card');
    return runtime.overlay(sessionId)!.messages.find((m) => m.input && !m.input.resolved)!.input!;
  };
  return { workspace, runtime, fakes, answered, project, dispatcher, sent, ask, ok, settle, pushes, listPushes, start, waiting, reviewStore, ticketStore };
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

  it('refuses what a phone never does', async () => {
    const d = await desk();
    const session = await d.start(agent, 'hello');
    await d.settle();
    for (const [op, reason] of Object.entries(NEVER_REMOTE)) expect(await d.ask(op, { sessionId: session.id })).toEqual({ ok: false, reason });
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

  it('takes the tags chosen on a tag card with the answer, as the desk does: an existing tag in its own writing, a new one as typed, Undo for all', async () => {
    const d = await desk();
    const other = await d.workspace.addSession({ title: 'Deploys', agent, startedIn: null });
    await d.workspace.tagSession(other.id, 'Argus');
    const { sessionId, card } = await suggested(d);
    expect(card.picks).toEqual({ of: 'tag', chosen: ['PROJ-482'], offered: ['Argus'], buttons: ['tag', 'always'] });
    const tagsOf = async () => (await d.workspace.state()).sessions.find((s) => s.id === sessionId)!.tags;
    // What the desk refuses, a phone is refused, with the reason; the card stays.
    expect(await d.ask('suggestion.answer', { sessionId, suggestionId: card.id, button: 'tag', picks: [] })).toEqual({ ok: false, reason: 'Choose at least one tag.' });
    expect(await d.ask('suggestion.answer', { sessionId, suggestionId: card.id, button: 'tag', picks: 'Argus' as never })).toEqual({ ok: false, reason: 'picks must be a short list of names.' });
    expect(await d.ask('suggestion.answer', { sessionId, suggestionId: card.id, button: 'tag', picks: Array.from({ length: 9 }, (_, i) => `t${i}`) })).toEqual({ ok: false, reason: 'At most 8 tags at a time.' });
    expect(await tagsOf()).toEqual([]);
    const answered = await d.ok('suggestion.answer', { sessionId, suggestionId: card.id, button: 'tag', picks: ['argus', 'Upload  hang'] });
    expect(answered.suggestion).toMatchObject({ state: 'answered', line: 'Tagged Argus, Upload hang' });
    expect(await tagsOf()).toEqual(['Argus', 'Upload hang']);
    expect((await d.ok('suggestion.undo', { sessionId, suggestionId: card.id })).suggestion.line).toBe('Untagged Argus, Upload hang');
    expect(await tagsOf()).toEqual([]);
  });

  it('refuses picks for a button or a card that takes none', async () => {
    const d = await desk();
    const { sessionId, card } = await suggested(d);
    expect(await d.ask('suggestion.answer', { sessionId, suggestionId: card.id, button: 'never', picks: ['Argus'] })).toEqual({ ok: false, reason: 'That button does not take a choice.' });
    expect(openSuggestions(d.runtime.recordOf(sessionId)!.messages)).toHaveLength(1);
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

describe.each(SELECTABLE_AGENTS)('the context window and Compact, for a %s session (Matt, 2026-11-24)', (agent) => {
  const usage = (used: number): ContextUsage => ({ model: 'fake', usedTokens: used, windowTokens: 100_000, rows: [{ name: 'Conversation', tokens: used, kind: 'used' }, { name: 'Free space', tokens: 100_000 - used, kind: 'free' }], at: 7 });

  it('reads how full the window is with the conversation, and gets each new measurement live', async () => {
    const d = await desk();
    const fake = d.fakes[agent];
    fake.script = (turn) => {
      if (turn.n > 1) turn.emit({ type: 'context', usage: usage(30_000 + turn.n) });
    };
    const session = await d.start(agent, 'look around');
    await d.settle();
    // Nothing measured yet: the words the window's ring shows in its place.
    expect(await d.ok('session.read', { sessionId: session.id })).toMatchObject({ context: null, contextNote: 'Not measured yet. It is measured each time a turn ends.' });
    await d.ok('session.watch', { sessionId: session.id });
    await d.ok('session.reply', { sessionId: session.id, text: 'more' });
    await d.settle();
    d.dispatcher.flush();
    expect(d.pushes().map((p) => p.body.patch.context).filter(Boolean)).toEqual([usage(30_002)]);
    const read = await d.ok('session.read', { sessionId: session.id });
    expect(read.context).toEqual(usage(30_002));
    expect(read.contextNote).toBeUndefined();
    // The same measurement the window's ring is given, through the same call.
    expect(read.context).toEqual(await d.runtime.contextUsage(session.id));
    // An earlier page is the conversation only.
    const first = await d.ok('session.read', { sessionId: session.id, last: 1 });
    expect((await d.ok('session.read', { sessionId: session.id, before: first.before, limit: 1 })).context).toBeUndefined();
  });

  it('compacts by the agent\'s own means as a turn, measured again at its end', async () => {
    const d = await desk();
    const fake = d.fakes[agent];
    fake.script = (turn) => {
      if (turn.text === COMPACTION) turn.emit({ type: 'context', usage: usage(1_000) });
    };
    const session = await d.start(agent, 'a long conversation');
    await d.settle();
    expect(await d.ok('session.compact', { sessionId: session.id })).toEqual({ compacting: true });
    await d.settle();
    expect(fake.compactions).toEqual([fake.starts[0]!.handle.agentSessionId()]);
    const read = await d.ok('session.read', { sessionId: session.id });
    expect(read.messages.map((m: ChatMessage) => m.text)).toContain('Compacting the conversation');
    expect(read.context).toEqual(usage(1_000));
    expect((await d.workspace.state()).sessions.find((s) => s.id === session.id)?.state).toBe('done');
  });

  it('is refused while the agent works, while a card waits, and for an agent that cannot', async () => {
    const d = await desk();
    const fake = d.fakes[agent];
    fake.hold = true;
    const session = await d.start(agent, 'busy');
    await d.settle();
    expect(await d.ask('session.compact', { sessionId: session.id })).toEqual({ ok: false, reason: 'The agent is working. Compact once this turn ends, or stop it first.' });
    fake.turns.at(-1)!.emit({ type: 'needs-input', request: { id: 'ask-1', kind: 'approval', title: 'Run a command', detail: 'make', tool: 'Bash', options: [{ id: 'allow', label: 'Allow', role: 'allow' }] } });
    await d.waiting(session.id);
    expect(await d.ask('session.compact', { sessionId: session.id })).toEqual({ ok: false, reason: 'This session is waiting on your answer to a card. Answer it first, then compact.' });
    await d.ok('session.answer', { sessionId: session.id, requestId: 'ask-1', optionId: 'allow' });
    fake.turns.at(-1)!.done();
    await d.settle();
    expect(fake.compactions).toEqual([]);

    // An agent with no way to compact from Kestrel says so (none of the three today).
    fake.hold = false;
    fake.canCompact = false;
    const other = await d.start(agent, 'another');
    await d.settle();
    expect(await d.ask('session.compact', { sessionId: other.id })).toEqual({ ok: false, reason: expect.stringMatching(/cannot compact a conversation from Kestrel\.$/) });
    expect(await d.ask('session.compact', { sessionId: 'no-such-session' })).toEqual({ ok: false, reason: 'That session is no longer in Kestrel.' });
  });
});

describe('the dispatcher stays in process', () => {
  it('imports no listener, socket or HTTP route, and nothing from security.ts', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      const source = readFileSync(join(here, file), 'utf8');
      expect(source).not.toMatch(/from '(node:)?(http|https|net)'|from '\.\.\/(http|security|kestrel-mcp)\.ts'|from 'ws'/);
      // What the user may open to read from anywhere on this computer is the window's alone (file-to-read.ts).
      expect(source).not.toMatch(/file-to-read|fileToRead/);
    }
  });
});

// Matt, 2026-11-24: "please add the code review and tickets pages" (kestrel-connect.md, "The Code reviews and
// Tickets pages on a phone"). Reads only, the window's views, kept current by push.
describe('the Code reviews and Tickets lists on a phone', () => {
  const request = (n: number, projectId: string | null = null): ReviewRequest => ({ host: 'github', hostName: 'github.com', repository: 'acme/shop', number: n, title: `Change ${n}`, author: 'sam', url: `https://github.com/acme/shop/pull/${n}`, updatedAt: n, key: `github.com/acme/shop#${n}`, projectId });
  const ticket = (n: number, source = 'github'): Ticket => ({ key: `${source}:acme/shop#${n}`, source, tracker: 'GitHub', ref: `shop#${n}`, title: `Bug ${n}`, status: { name: 'Open', category: 'todo' }, project: 'acme/shop', url: `https://github.com/acme/shop/issues/${n}`, openedAt: n, updatedAt: n });
  const reviews = (...rs: ReviewRequest[]): ReviewRequestsView => ({ ...NO_REVIEW_REQUESTS, requests: rs, unread: rs.map((r) => r.key) });
  const tickets = (ts: Ticket[], off: TicketsView['settings']['off'] = []): TicketsView => ({ ...NO_TICKETS, tickets: ts, unread: [ts[0]!.key], settings: { on: true, off, show: 'page' } });

  it('reads the review requests as the window has them, and Off in the desk words', async () => {
    const d = await desk();
    const view = reviews(request(1), request(2));
    d.reviewStore.set(view);
    expect(await d.ok('reviews.read')).toEqual({ on: true, view });
    await d.runtime.reviewPrefs.set({ mode: 'off' });
    expect(await d.ok('reviews.read')).toEqual({ on: false, reason: REVIEWS_OFF_REASON });
  });

  it('reads the tickets as the window has them, off in the desk words, and says which source is off', async () => {
    const d = await desk();
    expect(await d.ok('tickets.read')).toEqual({ on: false, reason: TICKETS_OFF_REASON });
    const view = tickets([ticket(1)], ['jira', 'github']);
    d.ticketStore.set(view);
    expect(await d.ok('tickets.read')).toEqual({ on: true, view, sourcesOff: ['Jira Cloud is switched off in Settings → Tickets.', 'GitHub issues are switched off in Settings → Tickets.'] });
  });

  it('pushes a changed list, once per burst, only to a device that read it, until it says bye', async () => {
    const d = await desk();
    await d.ok('reviews.read');
    d.reviewStore.set(reviews(request(1)));
    d.reviewStore.set(reviews(request(1), request(2)));
    d.ticketStore.set(tickets([ticket(1)]));
    d.dispatcher.flush();
    await until(() => d.listPushes().length > 0, 'a push');
    expect(d.listPushes().map((p) => [p.to, p.body])).toEqual([[PHONE, { type: 'reviews', reviews: { on: true, view: reviews(request(1), request(2)) } }]]);

    await d.dispatcher.receive({ v: CONNECT_PROTOCOL_VERSION, from: PHONE, to: MAC, kind: 'bye', id: 'b1', body: null });
    d.reviewStore.set(reviews(request(3)));
    d.dispatcher.flush();
    await Promise.resolve();
    expect(d.listPushes()).toHaveLength(1);
  });
});

// Matt, 2026-11-24: "1. Yep, it's the same seen 2. Yes, agree 3. Yes, agree 4. Also agree 5. Let's allow it to
// start a review / work a ticket." Each is the desk's button; the two starts follow A8 (kestrel-connect.md, "Actions").
const GH_TICKET = (n: number): Ticket => ({ key: `github:acme/shop#${n}`, source: 'github', tracker: 'GitHub', ref: `shop#${n}`, title: `Bug ${n}`, status: { name: 'Open', category: 'todo' }, project: 'acme/shop', url: `https://github.com/acme/shop/issues/${n}`, openedAt: n, updatedAt: n, sprint: null });

/** A desk with real review and ticket stores, a scripted GitHub tracker, and the Tickets routes the window uses. */
async function pagesDesk() {
  const tracker = { moved: [] as string[], comments: [] as string[], reads: 0 };
  const source: TicketSource = {
    kind: 'github',
    name: 'GitHub',
    assignedToMe: async () => ready([GH_TICKET(1), GH_TICKET(2)]),
    status: async (t) => ready(t.status),
    read: async () => {
      tracker.reads++;
      return ready({ description: 'Steps to reproduce', criteria: [], comments: [] });
    },
    statuses: async () => ready([{ name: 'In review', category: 'in-review' as const }]),
    move: async (t, to) => {
      tracker.moved.push(`${t.ref}→${to}`);
      return { name: to, category: 'in-review' as const };
    },
    comment: async (_t, body) => void tracker.comments.push(body),
  };
  const reviewRequests = new ReviewRequestStore();
  const ticketStore = new TicketStore({ settings: { on: true, off: [], show: 'page' } });
  const sync = syncTickets(async () => [source], ticketStore, () => true, Date.now, false);
  await sync.check();
  const d = await desk((workspace, runtime) => ({
    reviewRequests,
    tickets: {
      store: ticketStore,
      sync,
      work: {
        projects: async () => (await workspace.state()).projects,
        sessions: async () => (await workspace.state()).sessions,
        originOf: async () => null,
        start: (req) => runtime.start(req),
        tag: (id, tag) => workspace.tagSession(id, tag),
      },
    },
  }));
  const request = (n: number, projectId: string | null = d.project.id): ReviewRequest => ({ host: 'github', hostName: 'github.com', repository: 'acme/shop', number: n, title: `Change ${n}`, author: 'sam', url: `https://github.com/acme/shop/pull/${n}`, updatedAt: n, key: `github.com/acme/shop#${n}`, projectId });
  return { ...d, tracker, reviewRequests, ticketStore, request };
}

describe('the Code reviews and Tickets buttons on a phone', () => {
  it('marks read and unread, and dismisses and restores, in the one record every device shows', async () => {
    const d = await pagesDesk();
    const r = d.request(1);
    d.reviewRequests.set('github.com', ready([r]));
    expect(d.reviewRequests.view().unread).toEqual([r.key]);
    expect(await d.ok('reviews.seen', { keys: [r.key], seen: true })).toEqual({ ok: true });
    expect(d.reviewRequests.view().unread).toEqual([]);
    expect(await d.ok('reviews.dismiss', { keys: [r.key], dismissed: true })).toEqual({ ok: true });
    expect(d.reviewRequests.view().dismissed.map((x) => x.key)).toEqual([r.key]);
    // Undo is the same call the other way.
    await d.ok('reviews.dismiss', { keys: [r.key], dismissed: false });
    await d.ok('reviews.seen', { keys: [r.key], seen: false });
    expect(d.reviewRequests.view()).toMatchObject({ requests: [r], unread: [r.key], dismissed: [] });

    const key = GH_TICKET(1).key;
    await d.ok('tickets.seen', { keys: [key], seen: true });
    expect(d.ticketStore.view().unread).not.toContain(key);
    await d.ok('tickets.dismiss', { keys: [key], dismissed: true });
    expect(d.ticketStore.view().dismissed.map((t) => t.key)).toEqual([key]);
  });

  it('moves a ticket by hand, comments on it and asks for its page, through the desk\'s own functions', async () => {
    const d = await pagesDesk();
    const key = GH_TICKET(1).key;
    expect(await d.ok('tickets.statuses', { key })).toEqual(ready([{ name: 'In review', category: 'in-review' }]));
    await d.ok('tickets.move', { key, to: 'In review' });
    expect(d.tracker.moved).toEqual(['shop#1→In review']);
    await d.ok('tickets.comment', { key, body: '  Seen from my phone.  ' });
    expect(d.tracker.comments).toEqual(['Seen from my phone.']);
    expect(await d.ok('tickets.detail', { key })).toEqual({ ok: true });
    await until(() => d.tracker.reads > 0, 'the tracker is asked');
  });

  it('refuses each in the desk\'s words: tickets off, a source off, a ticket not held, a request no longer waiting', async () => {
    const d = await pagesDesk();
    expect(await d.ask('tickets.comment', { key: 'github:acme/shop#99', body: 'hi' })).toEqual({ ok: false, reason: 'Kestrel does not hold that ticket.' });
    expect(await d.ask('reviews.start', { key: 'github.com/acme/shop#404' })).toEqual({ ok: false, reason: 'This review is no longer waiting on you: it was reviewed, merged, closed, or the request was taken back.' });
    d.ticketStore.setSettings({ on: true, off: ['github'], show: 'page' });
    expect(await d.ask('tickets.move', { key: GH_TICKET(1).key, to: 'In review' })).toMatchObject({ ok: false, reason: expect.stringMatching(/not connected or is switched off/) });
    d.ticketStore.setSettings({ on: false, off: [], show: 'page' });
    for (const [op, args] of [['tickets.seen', { keys: ['k'], seen: true }], ['tickets.work', { key: GH_TICKET(1).key }], ['tickets.comment', { key: GH_TICKET(1).key, body: 'hi' }]] as const) {
      expect(await d.ask(op, args)).toEqual({ ok: false, reason: TICKETS_OFF_REASON });
    }
  });

  it('refuses a review of a repository that is no project, in the desk\'s words', async () => {
    const d = await pagesDesk();
    d.reviewRequests.set('github.com', ready([d.request(5, null)]));
    expect(await d.ask('reviews.start', { key: d.request(5).key })).toEqual({ ok: false, reason: 'acme/shop is not a project in Kestrel. Add it as a project, then start the review.' });
  });

  it('refuses both starts while this computer\'s switch is off (A8)', async () => {
    const d = await pagesDesk();
    d.reviewRequests.set('github.com', ready([d.request(1)]));
    await d.runtime.remoteStarts.setAllowed(false);
    for (const [op, args] of [['reviews.start', { key: d.request(1).key }], ['tickets.work', { key: GH_TICKET(1).key }]] as const) {
      expect(await d.ask(op, args)).toEqual({ ok: false, reason: remoteStartsOff('your Mac') });
    }
    expect((await d.workspace.state()).sessions).toEqual([]);
  });

  it('a phone can never ask for a mode: Bypass is chosen at the desk', async () => {
    const d = await pagesDesk();
    expect(await d.ask('tickets.work', { key: GH_TICKET(1).key, permission: 'bypass' })).toEqual({ ok: false, reason: 'tickets.work takes no permission.' });
  });
});

describe.each(SELECTABLE_AGENTS)('starting from a phone, for a %s lead (A8)', (agent) => {
  it('works a ticket with the choices the desk\'s button sends, and gives the lead back the second time', async () => {
    const d = await pagesDesk();
    await d.workspace.setUiState(JSON.stringify({ remembered: { agent, projectId: null, byAgent: { [agent]: { model: '', effort: '', fast: false, permission: 'ask' } } } }));
    const first = await d.ok('tickets.work', { key: GH_TICKET(2).key });
    expect(first.started).toBe(true);
    const session = (await d.workspace.state()).sessions.find((s) => s.id === first.sessionId)!;
    expect(session.agent).toBe(agent);
    await until(() => d.fakes[agent].starts.length > 0, 'the lead starts');
    expect(d.fakes[agent].starts[0]!.options.permission).toBe('ask');
    expect(await d.ok('tickets.work', { key: GH_TICKET(2).key })).toEqual({ sessionId: first.sessionId, started: false });
    await d.settle();
  });

  it('starts a review as the desk\'s button does, marked as from another device, and gives it back the second time', async () => {
    const d = await pagesDesk();
    const r = d.request(3);
    d.reviewRequests.set('github.com', ready([r]));
    d.reviewRequests.dismiss([r.key], true);
    // Fetching the request's head needs its host, so the runtime's start is stood in for; start.test.ts covers it.
    const asked: StartReviewOptions[] = [];
    d.runtime.startReview = async (request, opts = {}) => {
      asked.push(opts);
      const existing = (await d.workspace.state()).sessions.find((s) => s.title === request.title);
      return existing ?? d.runtime.start({ agent, projectId: request.projectId, prompt: `review ${request.key}`, title: request.title } as never);
    };
    const first = await d.ok('reviews.start', { key: r.key });
    expect(first.started).toBe(true);
    expect(asked).toEqual([{ remote: true }]);
    // As the desk's button: the request is restored and read.
    expect(d.reviewRequests.view()).toMatchObject({ requests: [r], dismissed: [], unread: [] });
    expect(await d.ok('reviews.start', { key: r.key })).toEqual({ sessionId: first.sessionId, started: false });
    await d.settle();
  });
});


describe('the day’s desk changes on a phone (2026-11-24)', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567';
  const failing = (): PullRequest => ({ number: 431, title: 'Polish the sign-in form', state: 'open', checks: 'failing', review: 'none', url: 'https://github.com/o/r/pull/431', headSha: SHA, baseBranch: 'main', failedChecks: [{ name: 'lint', url: 'https://github.com/o/r/actions/runs/1/job/2' }] });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** A desk whose phone reads pull requests from a real PR store. */
  async function prDesk() {
    const store = new PullRequestStore(() => 0);
    const d = await desk((workspace, runtime) => ({ lists: connectLists(runtime.reviewPrefs, null, null, { store, prefs: runtime.gitPrefs, workspace }) }));
    let n = 0;
    const answer = (id: string, prs: PullRequest[]) => store.get(id, `k${++n}`, async () => ready({ host: 'github' as const, pullRequests: prs }));
    return { ...d, store, answer };
  }

  it('pullRequests.read gives the store’s answers, the desk’s fact of what needs the user, and the Settings → Git choices', async () => {
    const d = await prDesk();
    const session = await d.start('claude');
    await d.settle();
    await d.answer(session.id, [failing()]);
    const result = await d.ok('pullRequests.read');
    expect(result.prefs).toEqual(DEFAULT_ATTENTION_PREFS);
    expect(result.pullRequests[session.id]).toMatchObject({ state: 'ready', value: { host: 'github', pullRequests: [{ number: 431, failedChecks: [{ name: 'lint' }] }] } });
    expect(result.attention[session.id]).toMatchObject({ number: 431, commit: SHA, reasons: [{ reason: 'checks-failed', checks: [{ name: 'lint' }] }] });
    // A reason switched off in Settings → Git is not watched: the fact goes, the request stays.
    await d.runtime.gitPrefs.setAttention({ reason: 'checks-failed', watch: false });
    const after = await d.ok('pullRequests.read');
    expect(after.attention).toEqual({});
    expect(after.pullRequests[session.id]).toBeDefined();
  });

  it('is pushed again to a device that read it, once per real change, and only then', async () => {
    const d = await prDesk();
    const session = await d.start('claude');
    await d.settle();
    await sleep(PULL_REQUESTS_LOOK_MS * 2);
    await d.ok('pullRequests.read');
    await d.answer(session.id, [failing()]);
    await sleep(PULL_REQUESTS_LOOK_MS * 2);
    d.dispatcher.flush();
    const pushed = d.listPushes().filter((f) => (f.body as ConnectPush).type === 'pull-requests');
    expect(pushed).toHaveLength(1);
    expect((pushed[0]!.body as Extract<ConnectPush, { type: 'pull-requests' }>).pullRequests.attention[session.id]).toBeDefined();
    // A workspace change that does not change the answer is not pushed.
    await d.workspace.seen.mark([session.id]);
    await sleep(PULL_REQUESTS_LOOK_MS * 2);
    d.dispatcher.flush();
    expect(d.listPushes().filter((f) => (f.body as ConnectPush).type === 'pull-requests')).toHaveLength(1);
  });

  describe.each(SELECTABLE_AGENTS)('a %s session', (agent) => {
    it('answers the “pull request needs you” card from a phone: its main button sends the agent a turn, and Dismiss leaves the next', async () => {
      const d = await prDesk();
      const session = await d.start(agent);
      await d.settle();
      const watch = d.runtime.watchRequestAttention(d.store);
      await d.answer(session.id, [failing()]);
      await watch.look();
      const card = openSuggestions(d.runtime.recordOf(session.id)?.messages ?? []).find((s) => s.kind === REQUEST_KIND)!;
      expect(card.buttons.map((b) => b.label)).toEqual(['Fix them', 'Dismiss', 'Don’t ask again']);
      const turns = d.fakes[agent].turns.length;
      expect(await d.ok('suggestion.answer', { sessionId: session.id, suggestionId: card.id, button: 'fix' })).toMatchObject({ suggestion: { state: 'answered' } });
      await d.settle();
      expect(d.fakes[agent].turns.length).toBe(turns + 1);
      expect(d.fakes[agent].turns.at(-1)!.text).toContain('lint');

      // Conflicts on the next look: dismissed from the phone, nothing sent.
      await d.answer(session.id, [{ ...failing(), checks: 'passing', failedChecks: undefined, readiness: 'conflicts' }]);
      await watch.look();
      const conflicts = openSuggestions(d.runtime.recordOf(session.id)?.messages ?? []).find((s) => s.kind === REQUEST_KIND)!;
      expect(await d.ok('suggestion.dismiss', { sessionId: session.id, suggestionId: conflicts.id })).toMatchObject({ suggestion: { state: 'dismissed' } });
      expect(d.fakes[agent].turns.length).toBe(turns + 1);
    });

    it('answers the offer to archive a review session after an approval, and Undo brings the session back', async () => {
      const d = await desk();
      const base = { host: 'github' as const, hostName: 'github.com', repository: 'acme/app', number: 12, title: 'Fix the cache', author: 'sam', url: 'https://github.com/acme/app/pull/12', updatedAt: 1, projectId: null };
      const key = reviewRequestKey(base);
      const session = await d.runtime.start({ agent, projectId: null, prompt: 'Review it', title: 'Review: Fix the cache', review: { key, host: 'github', number: 12, sha: 'a'.repeat(40), url: base.url } });
      await d.settle();
      await d.runtime.approvalPosted(session.id, '#12');
      const offer = openSuggestions(d.runtime.recordOf(session.id)?.messages ?? []).find((s) => s.kind === ARCHIVE_KIND)!;
      expect(offer.buttons.map((b) => b.label)).toEqual(['Archive', 'Always archive', 'Not now', "Don't ask again"]);
      expect(await d.ok('suggestion.answer', { sessionId: session.id, suggestionId: offer.id, button: 'archive' })).toMatchObject({ suggestion: { state: 'answered' } });
      expect((await d.workspace.state()).archived.sessions.map((s) => s.id)).toContain(session.id);
      await d.ok('suggestion.undo', { sessionId: session.id, suggestionId: offer.id });
      expect((await d.workspace.state()).sessions.map((s) => s.id)).toContain(session.id);
    });

    it('acts on a finding and on the card left when the review ended, as the desk’s buttons do', async () => {
      const d = await desk();
      const session = await d.start(agent);
      await d.settle();
      d.runtime.showCard(session.id, { type: 'card', id: 'round-1', roundFindings: ROUND });
      const answered = await d.ok('findings.act', { sessionId: session.id, cardId: 'round-1', findingId: 'f1', action: 'answer', text: 'Archive them.' });
      expect(answered.finding).toMatchObject({ id: 'f1', answer: 'Archive them.' });
      expect(await d.ask('findings.act', { sessionId: session.id, cardId: 'round-1', findingId: 'f2', action: 'answer', text: 'x' })).toEqual({ ok: false, reason: 'This finding asks no question.' });
      expect(await d.ok('findings.act', { sessionId: session.id, cardId: 'round-1', findingId: 'f2', action: 'dismiss' })).toMatchObject({ finding: { id: 'f2', dismissed: true } });
      expect(await d.ask('findings.act', { sessionId: session.id, cardId: 'nope', findingId: 'f1', action: 'fix' })).toEqual({ ok: false, reason: 'There is no such review card in this session.' });
      await d.settle();

      d.runtime.showCard(session.id, { type: 'card', id: 'end-1', reviewEnd: { reviewer: 'Astra', reviewerId: 'reviewer', rounds: 2, card: 'round-1', state: 'open' } });
      expect(await d.ok('reviewEnd.act', { sessionId: session.id, cardId: 'end-1', action: 'close' })).toMatchObject({ reviewEnd: { state: 'closed' } });
      expect(await d.ok('reviewEnd.act', { sessionId: session.id, cardId: 'end-1', action: 'reopen' })).toMatchObject({ reviewEnd: { state: 'open' } });
      const turns = d.fakes[agent].turns.length;
      await d.ok('reviewEnd.act', { sessionId: session.id, cardId: 'end-1', action: 'fix', findingIds: ['f1'] });
      await d.settle();
      expect(d.fakes[agent].turns.length).toBe(turns + 1);
    });
  });

  it('the action lists are the routes’ own', () => {
    expect(FINDING_ACTIONS).toEqual(['answer', 'fix', 'dismiss', 'restore']);
    expect(REVIEW_END_ACTIONS).toEqual(['fix', 'close', 'reopen']);
  });

  it('refuses every op on a sidebar, which a phone leaves out by its mark', async () => {
    const d = await desk();
    const repo = await d.runtime.registerProject(makeRepo(), 'repo');
    const main = await d.start('claude', 'Build it', repo.id);
    await d.settle();
    d.runtime.showCard(main.id, { type: 'card', id: 'round-1', roundFindings: ROUND });
    const aside = await d.runtime.asides.open(main.id, { at: 'round-1', key: 'round-1/f1', subject: { name: 'Finding #1', summary: 'Drafts are deleted after a week.' } });
    const state = await d.ok('state.read');
    expect(state.sessions.find((s: Session & { aside?: unknown }) => s.id === aside.id)?.aside).toBeTruthy();
    for (const [op, args] of [
      ['session.read', {}],
      ['session.watch', {}],
      ['session.reply', { text: 'hi' }],
      ['session.stop', {}],
      ['session.seen', {}],
      ['findings.act', { cardId: 'round-1', findingId: 'f1', action: 'fix' }],
    ] as const) {
      expect(await d.ask(op, { sessionId: aside.id, ...args })).toEqual({ ok: false, reason: ASIDE_REFUSAL });
    }
    expect(await d.ok('session.read', { sessionId: main.id })).toMatchObject({ sessionId: main.id });
  });
});

const ROUND: RoundFindings = {
  reviewer: 'Astra',
  reviewerId: 'reviewer',
  round: 2,
  rounds: 2,
  verdict: 'findings',
  summary: 'Two things.',
  findings: [
    { id: 'f1', brief: 'Drafts are deleted after a week.', priority: 'high', blocking: true, refs: [], question: 'Should they be archived instead?' },
    { id: 'f2', brief: 'A name is unclear.', priority: 'low', blocking: false, refs: [] },
  ],
};

describe.each(SELECTABLE_AGENTS)('a new session from a blank page on a phone, on %s (A8, Matt 2026-11-24)', (agent) => {
  const remembered = (permission: string) => JSON.stringify({ remembered: { agent, projectId: null, byAgent: { [agent]: { model: 'm-desk', effort: '', fast: false, permission } } } });

  it('starts with the New session box\'s choices here, the typed message first', async () => {
    const d = await desk();
    await d.workspace.setUiState(remembered('auto'));
    const { sessionId } = await d.ok('session.start', { projectId: d.project.id, text: 'Fix the checkout' });
    const session = (await d.workspace.state()).sessions.find((s) => s.id === sessionId)!;
    expect(session.agent).toBe(agent);
    await until(() => d.fakes[agent].starts.length > 0, 'the session starts');
    expect(d.fakes[agent].starts[0]!.prompt).toContain('Fix the checkout');
    expect(d.fakes[agent].starts[0]!.options.permission).toBe('auto');
    await d.settle();
  });

  it('takes the agent and the mode the phone picked', async () => {
    const d = await desk();
    await d.workspace.setUiState(remembered('auto'));
    const { sessionId } = await d.ok('session.start', { projectId: d.project.id, agent, mode: 'ask', text: 'go' });
    await until(() => d.fakes[agent].starts.length > 0, 'the session starts');
    expect(d.fakes[agent].starts[0]!.options.permission).toBe('ask');
    expect((await d.workspace.state()).sessions.find((s) => s.id === sessionId)!.agent).toBe(agent);
    await d.settle();
  });

  it('takes a preset\'s agent and model', async () => {
    const d = await desk();
    await d.runtime.whoDoesWhat.set({ ...(await d.runtime.whoDoesWhat.current()), presets: [{ id: 'quick', name: 'Quick', agent, model: 'm-preset', effort: '', fast: false }] });
    const choices = await d.ok('session.startChoices');
    expect(choices).toMatchObject({ here: 'your Mac', allowed: true, agents: [...SELECTABLE_AGENTS], presets: [expect.objectContaining({ id: 'quick' })] });
    await d.ok('session.start', { projectId: d.project.id, presetId: 'quick', text: 'go' });
    await until(() => d.fakes[agent].starts.length > 0, 'the session starts');
    expect(d.fakes[agent].starts[0]!.options.model).toBe('m-preset');
    await d.settle();
  });

  it('never starts in Bypass, even when the desk\'s box would', async () => {
    const d = await desk();
    await d.workspace.setUiState(remembered('bypass'));
    expect((await d.ok('session.startChoices')).start.permission).not.toBe('bypass');
    expect(await d.ask('session.start', { projectId: d.project.id, mode: 'bypass', text: 'go' })).toEqual({ ok: false, reason: BYPASS_FROM_ELSEWHERE });
    await d.ok('session.start', { projectId: d.project.id, text: 'go' });
    await until(() => d.fakes[agent].starts.length > 0, 'the session starts');
    expect(d.fakes[agent].starts[0]!.options.permission).not.toBe('bypass');
    await d.settle();
  });
});

describe.each(SELECTABLE_AGENTS)('a provider and a model by name on a phone, on %s (Matt, 2026-11-25)', (agent) => {
  const listed: ModelOption[] = [
    { id: '', label: 'Default', description: 'Use the default model (currently Wren 3)', resolves: 'wren-3' },
    { id: 'wren-3', label: 'Wren 3', resolves: 'wren-3', efforts: ['low', 'high'], fast: true },
    { id: 'wren-2', label: 'Wren 2' },
    { id: 'kite-1', label: 'Kite 1', efforts: ['low'] },
  ];
  const remembered = (model: string) => JSON.stringify({ remembered: { agent, projectId: null, byAgent: { [agent]: { model, effort: 'high', fast: true, permission: 'auto' } } } });
  const withModels = async () => {
    const d = await desk();
    d.runtime.models = async (a) => ({ models: a === agent ? listed : [{ id: '', label: 'Default' }], fromSdk: true });
    return d;
  };

  it('lists each connected provider with the desk\'s own menu rows, and the box\'s model as the default', async () => {
    const d = await withModels();
    await d.workspace.setUiState(remembered('wren-2'));
    const { providers, missing } = await d.ok('session.startChoices');
    expect(missing).toEqual([]);
    expect(providers.map((p: { agent: Agent }) => p.agent)).toEqual([...SELECTABLE_AGENTS]);
    expect(providers.find((p: { agent: Agent }) => p.agent === agent)).toEqual({
      agent,
      name: AGENT_LABEL[agent],
      models: [
        { id: 'wren-3', name: 'Wren 3' },
        { id: 'kite-1', name: 'Kite 1' },
        { id: 'wren-2', name: 'Wren 2', more: true },
      ],
      default: 'wren-2',
    });
  });

  it('starts on the model picked, with the box\'s effort and fast mode fitted to it', async () => {
    const d = await withModels();
    await d.workspace.setUiState(remembered('wren-3'));
    await d.ok('session.start', { projectId: d.project.id, agent, model: 'kite-1', text: 'go' });
    await until(() => d.fakes[agent].starts.length > 0, 'the session starts');
    const { options } = d.fakes[agent].starts[0]!;
    expect(options.model).toBe('kite-1');
    expect(options.effort ?? '').toBe('');
    expect(options.permission).toBe('auto');
    await d.settle();
  });

  it('refuses a model the agent does not offer here, and an agent that cannot start', async () => {
    const d = await withModels();
    expect(await d.ask('session.start', { projectId: d.project.id, agent, model: 'nope-9', text: 'go' })).toEqual({ ok: false, reason: notAModel('nope-9', agent, 'your Mac') });
    d.runtime.agentAvailability = async () => ({ available: SELECTABLE_AGENTS.filter((a) => a !== agent), notes: { [agent]: `${AGENT_LABEL[agent]} is not signed in.` }, signIn: [] });
    const { providers, missing } = await d.ok('session.startChoices');
    expect(providers.map((p: { agent: Agent }) => p.agent)).not.toContain(agent);
    expect(missing).toEqual([{ agent, name: AGENT_LABEL[agent], reason: `${AGENT_LABEL[agent]} is not signed in.` }]);
    expect(await d.ask('session.start', { projectId: d.project.id, agent, model: 'wren-3', text: 'go' })).toEqual({ ok: false, reason: `${AGENT_LABEL[agent]} is not signed in.` });
    expect((await d.workspace.state()).sessions).toEqual([]);
  });

  it('refuses a model without its agent, and a preset with one', async () => {
    const d = await withModels();
    expect(await d.ask('session.start', { projectId: d.project.id, model: 'wren-3', text: 'go' })).toEqual({ ok: false, reason: MODEL_WITHOUT_AGENT });
    expect(await d.ask('session.start', { projectId: d.project.id, presetId: 'quick', agent, model: 'wren-3', text: 'go' })).toEqual({ ok: false, reason: 'Give a preset or an agent, not both.' });
  });
});

describe('a new session from a phone is refused, with the reason', () => {
  it('while this computer\'s switch is off, and says so in its choices', async () => {
    const d = await desk();
    await d.runtime.remoteStarts.setAllowed(false);
    expect(await d.ok('session.startChoices')).toMatchObject({ allowed: false, refusal: remoteStartsOff('your Mac') });
    expect(await d.ask('session.start', { projectId: d.project.id, text: 'go' })).toEqual({ ok: false, reason: remoteStartsOff('your Mac') });
    expect((await d.workspace.state()).sessions).toEqual([]);
  });

  it('for a preset no longer here, or a project that is not', async () => {
    const d = await desk();
    expect(await d.ask('session.start', { projectId: d.project.id, presetId: 'gone', text: 'go' })).toEqual({ ok: false, reason: noSuchPreset('your Mac') });
    expect(await d.ask('session.start', { projectId: 'nope', text: 'go' })).toMatchObject({ ok: false, reason: expect.any(String) });
    expect((await d.workspace.state()).sessions).toEqual([]);
  });
});
