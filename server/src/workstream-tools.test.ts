// complete_workstream (the lead marks its workstream complete), through a real runtime with a
// scripted agent.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { SessionRuntime } from './runtime.ts';
import { FakeAgents, until, type Turn } from './test-agent.ts';
import { makeRepo } from './test-repo.ts';
import { Workspace } from './workspace.ts';

// Real repositories and worktrees: slow under a full parallel run (see delegation.test.ts).
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

const SPLIT = 'split the work';
const FINISH = 'all done';
const FINISH_TWICE = 'all done, twice';
const LAST_WORD = 'Shipped PDF invoices in A and B.';

async function world() {
  const workspace = new Workspace(memoryPersistence());
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-wst-')));
  const agents = new FakeAgents();
  const runtime = new SessionRuntime(workspace, { claude: agents.adapter() }, data);
  const a = await runtime.registerProject(makeRepo(), 'repoA');
  await runtime.registerProject(makeRepo(), 'repoB');
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await agents.settled();
      for (const s of (await workspace.state()).sessions) await runtime.idle(s.id);
    }
  };
  const results = new Map<string, { text: string; isError?: boolean }>();
  /** A child's turn waits on this while `holdChildren` is set, so it is still working. */
  let release: () => void = () => undefined;
  const gate = { held: false, wait: Promise.resolve() };
  const holdChildren = () => {
    gate.held = true;
    gate.wait = new Promise<void>((resolve) => (release = resolve));
  };
  agents.script = async (turn: Turn) => {
    if (turn.text === SPLIT) {
      await turn.options.tools.delegate({ tasks: [{ project: 'repoB', brief: 'Change B' }], name: 'Invoices' });
      turn.emit({ type: 'message', id: 'last-word', text: LAST_WORD, delta: LAST_WORD, done: true });
    } else if (turn.text === FINISH) results.set('complete', await turn.options.tools.completeWorkstream({}));
    else if (turn.text === FINISH_TWICE) {
      await turn.options.tools.completeWorkstream({});
      results.set('complete', await turn.options.tools.completeWorkstream({}));
    }
    else if (turn.text.startsWith('Change B') && gate.held) await gate.wait;
  };
  /** A lead in repoA (Auto, so no approval card) that delegated one task to repoB: a workstream of two. */
  const lead = await runtime.start({ agent: 'claude', projectId: a.id, prompt: SPLIT, permission: 'auto' });
  return { workspace, runtime, agents, settle, results, holdChildren, release: () => release(), lead };
}

const theWorkstream = async (w: Awaited<ReturnType<typeof world>>) => {
  const state = await w.workspace.state();
  return [...state.workstreams, ...state.archivedWorkstreams][0]!;
};

describe('complete_workstream', () => {
  it('the lead marks its workstream complete, through the same status the menu sets; nothing moves, stops or is archived', async () => {
    const w = await world();
    await w.settle();
    const before = await w.workspace.state();
    await w.runtime.reply(w.lead.id, FINISH);
    await w.settle();
    expect(w.results.get('complete')).toEqual({ text: expect.stringMatching(/^Marked “Invoices” complete\./) });
    const after = await w.workspace.state();
    expect((await theWorkstream(w)).status).toBe('complete');
    expect(after.archivedWorkstreams).toEqual([]);
    // Same sessions, same places, same links.
    expect(after.sessions.map((s) => [s.id, s.groupId, s.startedIn])).toEqual(before.sessions.map((s) => [s.id, s.groupId, s.startedIn]));
    expect(after.links).toEqual(before.links);
  });

  it('a worker is refused with the reason, naming the lead, and the conversation shows it', async () => {
    const w = await world();
    await w.settle();
    const workstream = await theWorkstream(w);
    const worker = workstream.sessionIds[1]!;
    await w.runtime.reply(worker, FINISH);
    await w.settle();
    expect(w.results.get('complete')).toMatchObject({ isError: true, text: expect.stringMatching(/^Only the lead of “Invoices” marks it complete/) });
    expect(w.results.get('complete')!.text).toContain(w.lead.id);
    expect((await theWorkstream(w)).status ?? 'active').toBe('active');
    expect(w.runtime.overlay(worker)!.messages.some((m) => m.notice && /Kestrel refused complete_workstream/.test(m.text))).toBe(true);
  });

  it('a session in no workstream is refused', async () => {
    const w = await world();
    await w.settle();
    const alone = await w.runtime.start({ agent: 'claude', projectId: null, prompt: FINISH });
    await w.settle();
    expect(w.results.get('complete')).toMatchObject({ isError: true, text: expect.stringMatching(/not in a workstream/) });
    expect((await w.workspace.state()).sessions.find((s) => s.id === alone.id)).toBeDefined();
  });

  it('is refused while a session in it is still working, naming it; allowed once it finished', async () => {
    const w = await world();
    w.holdChildren();
    await until(async () => (await w.workspace.state()).workstreams.length === 1, 'the workstream');
    const workstream = await theWorkstream(w);
    const child = (await w.workspace.state()).sessions.find((s) => s.id === workstream.sessionIds[1])!;
    await until(async () => (await w.workspace.state()).sessions.find((s) => s.id === w.lead.id)!.state === 'done', 'the lead to finish its turn');
    expect((await w.workspace.state()).sessions.find((s) => s.id === child.id)!.state).toBe('running');
    await w.runtime.reply(w.lead.id, FINISH);
    await until(() => w.results.has('complete'), 'the tool call');
    expect(w.results.get('complete')).toMatchObject({ isError: true, text: expect.stringContaining(`“${child.title}” (${child.id})`) });
    expect((await theWorkstream(w)).status ?? 'active').toBe('active');
    w.release();
    await w.settle();
    await w.runtime.reply(w.lead.id, FINISH);
    await w.settle();
    expect((await theWorkstream(w)).status).toBe('complete');
  });

  it('already complete: a plain answer, not an error, and nothing changes', async () => {
    const w = await world();
    await w.settle();
    const workstream = await theWorkstream(w);
    // A user message would make a complete workstream active again, so the lead calls it twice in one turn.
    await w.runtime.reply(w.lead.id, FINISH_TWICE);
    await w.settle();
    expect((await theWorkstream(w)).status).toBe('complete');
    expect(w.results.get('complete')).toEqual({ text: '“Invoices” is already marked complete. Nothing changed.' });
  });
});
