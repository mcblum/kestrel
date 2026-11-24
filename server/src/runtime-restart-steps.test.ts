// Kestrel's own cards survive a restart (design doc, "Kestrel's own cards survive a restart"): the
// step behind each one is stored with the session, a new server over the same store keeps the card
// open and the session needing the user, and the answer is carried out by making the same call again
// with today's checks. A world that changed in between refuses it in its own words; a step cut off
// part way by a restart is never run again; nothing is done twice. For every agent.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, InputRequest, KestrelToolHost, ToolResult } from './agents/types.ts';
import type { Agent, ChatMessage } from './model.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { SessionRuntime } from './runtime.ts';
import { quitCheck } from './shared/quit-check.ts';
import { CUT_OFF_STEP, withStatus } from './shared/waiting-steps.ts';
import { cleanWhoDoesWhat } from './shared/who-does-what.ts';
import { FakeAgents, until } from './test-agent.ts';
import { makeRepo } from './test-repo.ts';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import { Workspace } from './workspace.ts';

vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

const AGENTS: Agent[] = ['claude', 'codex', 'opencode'];
type Tools = KestrelToolHost;

/** A server over one store that can be restarted; the agent is a scripted fake of the given kind. */
async function world(agent: Agent) {
  const db = memoryPersistence();
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-restart-steps-')));
  let fake = new FakeAgents();
  const adapters = (f: FakeAgents): Partial<Record<Agent, AgentAdapter>> => ({ [agent]: { ...f.adapter(), agent } });
  let workspace = new Workspace(db);
  let runtime = new SessionRuntime(workspace, adapters(fake), data);
  const app = await runtime.registerProject(makeRepo(), 'app');
  const home = await runtime.registerProject(makeRepo(), 'home');
  const results: ToolResult[] = [];
  const w = {
    get workspace() {
      return workspace;
    },
    get runtime() {
      return runtime;
    },
    get fake() {
      return fake;
    },
    app,
    home,
    results,
    /** A session whose first turn calls a tool and ends without waiting for the answer, leaving Kestrel's card open. */
    async ask(projectId: string | null, call: (tools: Tools) => Promise<ToolResult>, opts: { permission?: 'ask' | 'auto' } = {}) {
      fake.script = (turn) => {
        if (turn.text === 'go') void call(turn.options.tools as Tools).then((r) => results.push(r));
      };
      const session = await runtime.start({ agent, projectId, prompt: 'go', permission: opts.permission ?? 'ask' });
      await until(async () => (await w.row(session.id))?.state === 'attention' && w.openCard(session.id) !== undefined, 'the card');
      await runtime.idle(session.id);
      return session;
    },
    openCard(id: string) {
      return runtime.overlay(id)?.messages.map((m) => m.input).find((i) => i?.kestrel && !i.resolved);
    },
    async row(id: string) {
      return (await workspace.state()).sessions.find((s) => s.id === id);
    },
    async sessions() {
      return (await workspace.state()).sessions;
    },
    async stored(id: string) {
      return (await workspace.storedDetail(id))!;
    },
    /** Stops the server, runs `meanwhile` against the store it left, and starts a new one over it. */
    async restart(meanwhile: (ws: Workspace) => Promise<void> = async () => undefined) {
      await runtime.shutdown();
      await meanwhile(workspace);
      fake = new FakeAgents();
      workspace = new Workspace(db);
      runtime = new SessionRuntime(workspace, adapters(fake), data);
      await runtime.recoverAfterRestart();
    },
    /** Everything the agent has been told or is yet to be told: its inbox, live or stored, and the turns it was sent. */
    async heard(id: string) {
      return [...(runtime.recordOf(id)?.inbox ?? []), ...((await w.stored(id)).inbox ?? []), ...fake.turns.map((t) => t.text)].join('\n');
    },
    /** The card as the new server shows it, by reading the session. */
    async cardAfter(id: string) {
      const messages = runtime.overlay(id)?.messages ?? (await w.stored(id)).messages;
      return messages.map((m: ChatMessage) => m.input).find((i) => i?.kestrel);
    },
  };
  return w;
}

/** Each kind of step: the call that raises its card, and what a yes does. */
const KINDS: { kind: string; project: 'app' | 'home' | null; call: (w: Awaited<ReturnType<typeof world>>, extra: { targetId?: string; folder?: string }) => (tools: Tools) => Promise<ToolResult>; prepare?: (w: Awaited<ReturnType<typeof world>>, agent: Agent) => Promise<{ targetId?: string; folder?: string }>; done: (w: Awaited<ReturnType<typeof world>>, callerId: string, extra: { targetId?: string; folder?: string }, before: number) => Promise<boolean> }[] = [
  {
    kind: 'delegate',
    project: 'home',
    call: () => (t) => t.delegate({ tasks: [{ project: 'app', brief: 'Fix the cache' }] }),
    done: async (w, _c, _e, before) => (await w.sessions()).length === before + 1,
  },
  {
    kind: 'spawn',
    project: 'home',
    call: () => (t) => t.spawn({ project: 'app', brief: 'Tidy the docs' }),
    done: async (w, _c, _e, before) => (await w.sessions()).length === before + 1,
  },
  {
    kind: 'handoff',
    project: 'home',
    // A handoff asks only when it archives the caller too.
    call: () => (t) => t.handoff({ project: 'app', summary: 'Carry on with the cache work there.', archive_self: true }),
    done: async (w, callerId) => (await w.workspace.state()).archived.sessions.some((s) => s.id === callerId) && (await w.sessions()).some((s) => s.title.startsWith('Carry on')),
  },
  {
    kind: 'ask_session',
    project: 'home',
    prepare: (w, agent) => prepareTarget(w, agent),
    call: (_w, e) => (t) => t.askSession({ session: e.targetId!, message: 'Please also check the README' }),
    done: async (w) => w.fake.turns.some((t) => t.text.includes('Please also check the README')),
  },
  {
    kind: 'move_to_project',
    project: null,
    call: () => (t) => t.moveToProject({ project: 'app', reason: 'The work is there.' }),
    done: async (w, callerId) => (await w.row(callerId))?.startedIn === w.app.id,
  },
  {
    kind: 'add_project',
    project: 'home',
    prepare: async () => ({ folder: makeRepo() }),
    call: (_w, e) => (t) => t.addProject({ path: e.folder!, name: 'library' }),
    done: async (w) => (await w.workspace.state()).projects.some((p) => p.name === 'library'),
  },
];

describe.each(AGENTS)('Kestrel’s own cards over a restart, for %s', (agent) => {
  it.each(KINDS.map((k) => [k.kind, k] as const))('%s: the card stays open, the session needs you, and a yes after the restart does it', async (_kind, k) => {
    const w = await world(agent);
    const extra = k.prepare ? await k.prepare(w, agent) : {};
    const projectId = k.project === null ? null : w[k.project].id;
    const session = await w.ask(projectId, k.call(w, extra));
    const card = w.openCard(session.id)!;
    expect((await w.row(session.id))!.note).toBe(`Needs you · ${card.title}`);
    // Its step is stored, so it survives a restart: it holds no quit up.
    expect((await w.stored(session.id)).steps).toMatchObject([{ requestId: card.id, status: 'waiting', card: { title: card.title } }]);
    const steps = (await w.stored(session.id)).steps;
    expect(quitCheck(await w.sessions(), (id) => ({ messages: w.runtime.overlay(id)?.messages ?? [], steps: id === session.id ? steps : [] }))).toEqual({ working: [], waiting: [] });

    await w.restart();
    expect(await w.row(session.id)).toMatchObject({ state: 'attention', note: `Needs you · ${card.title}` });
    const after = await w.cardAfter(session.id);
    expect(after).toMatchObject({ id: card.id, title: card.title });
    expect(after!.resolved).toBeUndefined();
    const stored = await w.stored(session.id);
    expect(quitCheck(await w.sessions(), () => ({ messages: stored.messages, steps: stored.steps }))).toEqual({ working: [], waiting: [] });

    const before = (await w.sessions()).length;
    await w.runtime.answer(session.id, card.id, { optionId: 'allow' });
    await until(() => k.done(w, session.id, extra, before), `${k.kind} done after the restart`);
    expect((await w.cardAfter(session.id))!.resolved).toBe(card.options.find((o) => o.role === 'allow')!.label);
    expect((await w.stored(session.id)).steps ?? []).toEqual([]);
    // The agent hears what came of it with its next turn.
    expect(await w.heard(session.id)).toContain('The user approved it after the restart');
    // A second answer finds nothing waiting.
    await expect(w.runtime.answer(session.id, card.id, { optionId: 'allow' })).rejects.toThrow();
  });

  it('a no after the restart does nothing, closes the card and tells the agent', async () => {
    const w = await world(agent);
    const session = await w.ask(w.home.id, (t) => t.delegate({ tasks: [{ project: 'app', brief: 'Fix the cache' }] }));
    const card = w.openCard(session.id)!;
    await w.restart();
    const before = (await w.sessions()).length;
    await w.runtime.answer(session.id, card.id, { optionId: 'deny' });
    expect((await w.cardAfter(session.id))!.resolved).toBe('Decline');
    expect(await w.sessions()).toHaveLength(before);
    expect(await w.row(session.id)).toMatchObject({ state: 'done' });
    expect(await w.heard(session.id)).toContain('The user declined it after the restart. Nothing was done.');
  });

  it('stays open through a turn the user starts after the restart, and still does it when answered', async () => {
    const w = await world(agent);
    const session = await w.ask(w.home.id, (t) => t.spawn({ project: 'app', brief: 'Tidy the docs' }));
    const card = w.openCard(session.id)!;
    await w.restart();
    w.fake.script = () => undefined;
    await w.runtime.reply(session.id, 'While you wait: what does the cache do?');
    await until(() => w.fake.turns.some((t) => t.text.includes('what does the cache do')), 'the turn the user started');
    await w.runtime.idle(session.id);
    expect((await w.cardAfter(session.id))!.resolved).toBeUndefined();
    expect(await w.row(session.id)).toMatchObject({ state: 'attention', note: `Needs you · ${card.title}` });
    const before = (await w.sessions()).length;
    await w.runtime.answer(session.id, card.id, { optionId: 'allow' });
    await until(async () => (await w.sessions()).length === before + 1, 'the spawned session');
  });

  it('Stop after the restart declines it and closes the card', async () => {
    const w = await world(agent);
    const session = await w.ask(w.home.id, (t) => t.spawn({ project: 'app', brief: 'Tidy' }));
    const card = w.openCard(session.id)!;
    await w.restart();
    await w.runtime.stop(session.id);
    expect((await w.cardAfter(session.id))!.resolved).toBeDefined();
    expect((await w.stored(session.id)).steps ?? []).toEqual([]);
    await expect(w.runtime.answer(session.id, card.id, { optionId: 'allow' })).rejects.toThrow();
  });

  it('a world changed in between refuses the answer in its own words, and nothing is done', async () => {
    // The project the work was to go to is gone.
    const gone = await world(agent);
    const delegating = await gone.ask(gone.home.id, (t) => t.delegate({ tasks: [{ project: 'app', brief: 'Fix the cache' }] }));
    const card = gone.openCard(delegating.id)!;
    await gone.restart((ws) => ws.removeProject(gone.app.id));
    const before = (await gone.sessions()).length;
    await gone.runtime.answer(delegating.id, card.id, { optionId: 'allow' });
    const closed = (await gone.cardAfter(delegating.id))!.resolved!;
    expect(closed).toMatch(/^Not done: /);
    expect(closed).toContain('app');
    expect(await gone.sessions()).toHaveLength(before);
    expect(await gone.heard(delegating.id)).toContain('but it was not done');

    // The session it was to ask is gone.
    const asked = await world(agent);
    const target = await prepareTarget(asked, agent);
    const asking = await asked.ask(asked.home.id, (t) => t.askSession({ session: target.targetId!, message: 'Check it' }));
    const askCard = asked.openCard(asking.id)!;
    await asked.restart((ws) => ws.deleteSession(target.targetId!));
    await asked.runtime.answer(asking.id, askCard.id, { optionId: 'allow' });
    expect((await asked.cardAfter(asking.id))!.resolved).toContain(`Not done: No such session: ${target.targetId}`);

    // The folder it was to add is gone.
    const folder = makeRepo();
    const adding = await world(agent);
    const addingSession = await adding.ask(adding.home.id, (t) => t.addProject({ path: folder, name: 'library' }));
    const addCard = adding.openCard(addingSession.id)!;
    await adding.restart(async () => rmSync(folder, { recursive: true, force: true }));
    await adding.runtime.answer(addingSession.id, addCard.id, { optionId: 'allow' });
    expect((await adding.cardAfter(addingSession.id))!.resolved).toMatch(/^Not done: /);
    expect((await adding.workspace.state()).projects.some((p) => p.name === 'library')).toBe(false);
  });

  it('what the call would ask now differs from the card: refused, saying what it would ask', async () => {
    const w = await world(agent);
    const session = await w.ask(w.home.id, (t) => t.delegate({ tasks: [{ project: 'app', brief: 'Fix the cache' }] }));
    const card = w.openCard(session.id)!;
    // What was approved, as stored, is not what the call asks now.
    await w.restart(async (ws) => {
      const stored = (await ws.storedDetail(session.id))!;
      await ws.setDetail(session.id, { steps: stored.steps!.map((s) => ({ ...s, card: { ...s.card, detail: `${s.card.detail}\n(what was approved)` } })) });
    });
    const before = (await w.sessions()).length;
    await w.runtime.answer(session.id, card.id, { optionId: 'allow' });
    expect((await w.cardAfter(session.id))!.resolved).toContain('Not done: What this would do has changed since you were asked, so nothing was done.');
    expect(await w.sessions()).toHaveLength(before);
  });

  it('answered and cut off by a restart while being carried out: closed, the agent told, and never done again', async () => {
    const w = await world(agent);
    const session = await w.ask(w.home.id, (t) => t.delegate({ tasks: [{ project: 'app', brief: 'Fix the cache' }] }));
    const card = w.openCard(session.id)!;
    // The answer was being carried out (`taking` is written before anything is done) when the server went away.
    await w.restart(async (ws) => {
      const stored = (await ws.storedDetail(session.id))!;
      await ws.setDetail(session.id, { steps: withStatus(stored.steps!, card.id, 'taking') });
    });
    const before = (await w.sessions()).length;
    expect((await w.cardAfter(session.id))!.resolved).toBe(CUT_OFF_STEP);
    expect((await w.stored(session.id)).steps ?? []).toEqual([]);
    expect(await w.heard(session.id)).toContain('Kestrel restarted while doing it');
    await expect(w.runtime.answer(session.id, card.id, { optionId: 'allow' })).rejects.toThrow();
    expect(await w.sessions()).toHaveLength(before);
  });

  it('two answers at once after the restart start one delegate, not two', async () => {
    const w = await world(agent);
    const session = await w.ask(w.home.id, (t) => t.delegate({ tasks: [{ project: 'app', brief: 'Fix the cache' }] }));
    const card = w.openCard(session.id)!;
    await w.restart();
    const before = (await w.sessions()).length;
    const answers = await Promise.allSettled([w.runtime.answer(session.id, card.id, { optionId: 'allow' }), w.runtime.answer(session.id, card.id, { optionId: 'allow' })]);
    expect(answers.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    await until(async () => (await w.sessions()).length === before + 1, 'the one delegate');
    await w.runtime.idle(session.id);
    expect(await w.sessions()).toHaveLength(before + 1);
  });

  it('in Auto, a card that was raised is still asked after the restart: the old answer is never skipped past', async () => {
    const w = await world(agent);
    // move_to_project asks in every mode; after the restart the replay goes through its card too.
    const session = await w.ask(null, (t) => t.moveToProject({ project: 'app' }), { permission: 'auto' });
    const card = w.openCard(session.id)!;
    await w.restart();
    await w.runtime.answer(session.id, card.id, { optionId: 'allow' });
    await until(async () => (await w.row(session.id))?.startedIn === w.app.id, 'the move');
  });
});

describe('a role’s fallback preset over a restart', () => {
  const presets = [
    { id: 'astra', name: 'Astra', agent: 'codex', model: 'gpt-6.2-astra', effort: 'high', fast: false },
    { id: 'sonnet', name: 'Everyday', agent: 'claude', model: 'sonnet', effort: '', fast: false },
  ];
  const LIMIT = { type: 'failed' as const, reason: 'You have hit your usage limit', kind: 'other' as const };

  it('keeps the card where the work was handed out, and passes the part on when approved after the restart', async () => {
    const db = memoryPersistence();
    const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-restart-fallback-')));
    const make = () => {
      const claude = new FakeAgents();
      const codex = new FakeAgents();
      codex.script = (turn) => turn.emit(LIMIT);
      const workspace = new Workspace(db);
      return { claude, codex, workspace, runtime: new SessionRuntime(workspace, { claude: claude.adapter(), codex: codex.adapter() }, data) };
    };
    const first = make();
    const project = await first.runtime.registerProject(makeRepo(), 'app');
    const who = cleanWhoDoesWhat({ presets, roles: { design: 'astra' }, fallbacks: { design: ['sonnet'] }, instruction: '', whenUnavailable: 'ask' }, () => 'x');
    await first.runtime.whoDoesWhat.set(who);
    first.claude.script = async (turn) => {
      if (turn.text === 'go') await turn.options.tools.delegate({ tasks: [{ project: 'app', brief: 'Restyle the inputs', role: 'design' }] });
    };
    const lead = await first.runtime.start({ agent: 'claude', projectId: project.id, prompt: 'go', permission: 'auto' });
    const fallbackCard = (rt: SessionRuntime) => rt.overlay(lead.id)?.messages.map((m) => m.input).find((i): i is InputRequest & { resolved?: string } => !!i && i.id.startsWith('fallback-'));
    await until(() => fallbackCard(first.runtime) !== undefined, 'the fallback card');
    await first.runtime.idle(lead.id);
    const card = fallbackCard(first.runtime)!;
    expect((await first.workspace.storedDetail(lead.id))!.steps).toMatchObject([{ requestId: card.id, call: { kind: 'fallback' }, status: 'waiting' }]);
    expect(first.claude.starts).toHaveLength(1);

    await first.runtime.shutdown();
    const second = make();
    // The user's roles, as the app keeps them in its settings across a restart.
    await second.runtime.whoDoesWhat.set(who);
    await second.runtime.recoverAfterRestart();
    expect((await second.workspace.state()).sessions.find((s) => s.id === lead.id)).toMatchObject({ state: 'attention', note: `Needs you · ${card.title}` });
    await second.runtime.answer(lead.id, card.id, { optionId: 'allow' });
    await until(() => second.claude.starts.length === 1, 'the part on the next preset, once approved after the restart');
    expect(second.claude.starts[0]!.options.model).toBe('sonnet');
    expect(fallbackCard(second.runtime)!.resolved).toBe('Use Everyday');
  });
});

/** A finished session in `app` running `agent`, to be asked something (ask_session). */
async function prepareTarget(w: Awaited<ReturnType<typeof world>>, agent: Agent): Promise<{ targetId: string }> {
  w.fake.script = () => undefined;
  const target = await w.runtime.start({ agent, projectId: w.app.id, prompt: 'first' });
  await w.runtime.idle(target.id);
  return { targetId: target.id };
}
