// What a restart does to a session waiting on the user, for each agent (Matt, 2026-11-24: a session
// whose turn is done does not hold up a quit, because "if the turn is done and there's a card, it'll
// be there when I get back"). A turn paused on the agent's own card is cut off and the card closed;
// a finished turn keeps every card it left, and its status.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Agent, ChatMessage } from './model.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { SessionRuntime } from './runtime.ts';
import { quitCheck } from './shared/quit-check.ts';
import type { AgentAdapter, AgentEvent } from './agents/types.ts';
import { Workspace } from './workspace.ts';

const AGENTS: Agent[] = ['claude', 'codex', 'opencode'];

/** A scripted agent of any kind: no model, no timing. `turn` decides what each turn does. */
class Script {
  turn: (emit: (e: AgentEvent) => void) => void = (emit) => emit({ type: 'done', reason: 'complete' });
  constructor(private readonly agent: Agent) {}
  adapter(): AgentAdapter {
    const handle = (emit: (e: AgentEvent) => void, id: string) => {
      let busy = false;
      return {
        agentSessionId: () => id,
        busy: () => busy,
        send: (_text: string) => {
          busy = true;
          this.turn((e) => {
            if (e.type === 'done' || e.type === 'failed') busy = false;
            emit(e);
          });
        },
        answer: () => undefined,
        stop: async () => undefined,
      };
    };
    return {
      agent: this.agent,
      models: async () => ({ models: [{ id: '', label: 'Default' }], fromSdk: false }),
      start: (_options, prompt, emit) => {
        emit({ type: 'started', agentSessionId: 'agent-1', model: 'fake', kestrelTools: 'connected' });
        const h = handle(emit, 'agent-1');
        h.send(prompt);
        return h;
      },
      resume: (id, _options, emit) => handle(emit, id),
    } as AgentAdapter;
  }
}

async function setup(agent: Agent) {
  const db = memoryPersistence();
  const workspace = new Workspace(db);
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-restart-cards-')));
  const script = new Script(agent);
  const runtime = new SessionRuntime(workspace, { [agent]: script.adapter() }, data);
  /** Stops the server, runs `meanwhile` against the store it left, and starts a new one over it. */
  const restart = async (meanwhile: () => Promise<void> = async () => undefined) => {
    await runtime.shutdown();
    await meanwhile();
    const workspace2 = new Workspace(db);
    const runtime2 = new SessionRuntime(workspace2, { [agent]: new Script(agent).adapter() }, data);
    await runtime2.recoverAfterRestart();
    return { workspace2, runtime2 };
  };
  return { workspace, runtime, script, restart };
}

/** Every card a finished turn can leave: a next step, a review to post, a round's findings, the lasting findings card, a suggestion, a picture, a file. */
const FINISHED_TURN_CARDS = [
  { author: 'agent', time: '', text: '', next: { recap: 'Done.', ask: 'Ship it?', replies: ['Yes', 'No'] } },
  { author: 'agent', time: '', text: '', review: { verdict: 'comment', summary: 'Looks fine', findings: [] } },
  { author: 'agent', time: '', text: '', roundFindings: { round: 1, findings: [] } },
  { author: 'agent', time: '', text: '', reviewEnd: { reviewer: 'Reviewer', reviewerId: 'r', rounds: 1, card: 'c', at: 'm', state: 'open' } },
  { author: 'agent', time: '', text: '', suggestion: { id: 'sg1', kind: 'ticket', title: 'Move KES-1 to In review' } },
  { author: 'agent', time: '', text: '', widget: { title: 'Chart', code: '<svg/>' } },
] as unknown as ChatMessage[];

describe.each(AGENTS)('a restart, for %s', (agent) => {
  it('keeps every card a finished turn left, and the session still needs the user', async () => {
    const { workspace, runtime, script, restart } = await setup(agent);
    script.turn = (emit) => emit({ type: 'done', reason: 'complete' });
    const session = await runtime.start({ agent, projectId: null, prompt: 'review it' });
    await runtime.idle(session.id);
    // The cards as the stored conversation has them when the server stops (written by the runtime in use).
    const { workspace2 } = await restart(async () => {
      const stored = (await workspace.storedDetail(session.id))!;
      expect(stored.messages.find((m) => m.author === 'you')!.turnEndedAt).toBeDefined();
      await workspace.setDetail(session.id, { messages: [...stored.messages, ...FINISHED_TURN_CARDS] });
      await workspace.setState(session.id, 'attention', 'Needs you · Review findings');
      const messages = (await workspace.storedDetail(session.id))!.messages;
      expect(quitCheck((await workspace.state()).sessions, () => messages).working).toEqual([]);
    });
    expect((await workspace2.state()).sessions.find((s) => s.id === session.id)).toMatchObject({ state: 'attention', note: 'Needs you · Review findings' });
    const after = (await workspace2.storedDetail(session.id))!;
    for (const card of FINISHED_TURN_CARDS) expect(after.messages).toContainEqual(card);
    expect(after.inbox ?? []).toEqual([]);
  });

  it('keeps a failed turn as it was: the failure still shows, not "Interrupted"', async () => {
    const { workspace, runtime, script, restart } = await setup(agent);
    script.turn = (emit) => emit({ type: 'failed', reason: 'the model refused', kind: 'other' } as never);
    const session = await runtime.start({ agent, projectId: null, prompt: 'go' });
    await runtime.idle(session.id);
    const note = (await workspace.state()).sessions.find((s) => s.id === session.id)!.note;
    expect(note).toMatch(/^Failed/);
    const { workspace2 } = await restart();
    expect((await workspace2.state()).sessions.find((s) => s.id === session.id)).toMatchObject({ state: 'attention', note });
  });

  it('cuts off a turn paused on the agent’s own card, closes the card, and counts it as working for a quit', async () => {
    for (const request of [
      { id: 'a1', kind: 'approval', title: 'Run npm test', detail: 'npm test', tool: 'Bash', options: [{ id: 'allow', label: 'Allow', role: 'allow' }] },
      { id: 'q1', kind: 'question', title: 'Which database?', detail: 'Which database?', tool: 'AskUserQuestion', options: [{ id: 'a', label: 'SQLite', role: 'choice' }] },
      { id: 'p1', kind: 'approval', title: 'Plan ready', detail: '1. Do it', tool: 'ExitPlanMode', markdown: true, options: [{ id: 'allow', label: 'Approve', role: 'allow' }] },
    ] as const) {
      const { workspace, runtime, script, restart } = await setup(agent);
      script.turn = (emit) => emit({ type: 'needs-input', request } as never);
      const session = await runtime.start({ agent, projectId: null, prompt: 'go' });
      await runtime.idle(session.id);
      expect((await workspace.state()).sessions.find((s) => s.id === session.id)!.state).toBe('attention');
      const live = runtime.overlay(session.id)!.messages;
      expect(quitCheck((await workspace.state()).sessions, () => live).working.map((s) => s.id)).toEqual([session.id]);

      const { workspace2 } = await restart();
      expect((await workspace2.state()).sessions.find((s) => s.id === session.id)!.state).toBe('interrupted');
      expect((await workspace2.storedDetail(session.id))!.messages.find((m) => m.input)!.input!.resolved).toBe('Interrupted by restart');
    }
  });

  it('closes one of Kestrel’s own cards left open after its turn (an approval for delegate, add_project, move_to_project): it does not survive', async () => {
    const { workspace, runtime, script, restart } = await setup(agent);
    script.turn = (emit) => emit({ type: 'done', reason: 'complete' });
    const session = await runtime.start({ agent, projectId: null, prompt: 'go' });
    await runtime.idle(session.id);
    const asked = runtime.requestApproval(session.id, { id: 'add_project-1', kind: 'approval', tool: 'add_project', title: 'Add kite as a project?', detail: '/x', options: [{ id: 'allow', label: 'Add project', role: 'allow' }] });
    await runtime.idle(session.id);
    expect((await workspace.state()).sessions.find((s) => s.id === session.id)!.state).toBe('attention');
    const live = runtime.overlay(session.id)!.messages;
    expect(quitCheck((await workspace.state()).sessions, () => live).working).toEqual([]);

    const { workspace2 } = await restart();
    void asked;
    expect((await workspace2.state()).sessions.find((s) => s.id === session.id)!.state).toBe('interrupted');
    expect((await workspace2.storedDetail(session.id))!.messages.find((m) => m.input)!.input!.resolved).toBe('Interrupted by restart');
  });
});
