// A sidebar about a finding (asides.ts) and what the user does to a finding (finding-actions.ts),
// through a real runtime with a scripted agent and a real repository and worktree.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { SessionRuntime } from './runtime.ts';
import { FakeAgents, type Turn } from './test-agent.ts';
import { makeRepo } from './test-repo.ts';
import { Workspace } from './workspace.ts';
import { asideCut } from './asides.ts';
import { ASIDE_TOOL_REFUSAL } from './shared/asides.ts';
import { findingAsideKey, findingSubject } from './shared/findings.ts';
import type { RoundFindings } from './shared/round-findings.ts';

vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

const CARD = 'round-findings-test';
/** What the finding's control asks for. */
const aboutFinding = (n: 1 | 2) => ({ at: CARD, key: findingAsideKey(CARD, `f${n}`), subject: findingSubject(round.findings[n - 1]!, n) });

const round: RoundFindings = {
  reviewer: 'Astra',
  reviewerId: 'reviewer',
  round: 1,
  rounds: 2,
  verdict: 'findings',
  summary: 'Two things.',
  findings: [
    { id: 'f1', brief: 'Drafts are deleted after a week.', priority: 'high', blocking: true, refs: [{ path: 'README.md', line: 1 }], question: 'Should they be archived instead?' },
    { id: 'f2', brief: 'A name is unclear.', priority: 'low', blocking: false, refs: [] },
  ],
};

async function world() {
  const workspace = new Workspace(memoryPersistence());
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-aside-')));
  const agents = new FakeAgents();
  const runtime = new SessionRuntime(workspace, { claude: agents.adapter(), opencode: agents.adapter() }, data);
  const project = await runtime.registerProject(makeRepo(), 'repo');
  const turns: Turn[] = [];
  agents.script = (turn) => {
    turns.push(turn);
  };
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await agents.settled();
      for (const s of (await workspace.state()).sessions) await runtime.idle(s.id);
    }
  };
  /** A session that did a turn, with a rounds review card in its conversation. */
  const withCard = async (agent: 'claude' | 'opencode' = 'claude') => {
    const main = await runtime.start({ agent, projectId: project.id, prompt: 'Build it', permission: 'auto', model: 'opus' });
    await settle();
    runtime.showCard(main.id, { type: 'card', id: CARD, roundFindings: round });
    return main;
  };
  const cardOf = async (id: string) => runtime.overlay(id)?.messages.find((m) => m.id === CARD)?.roundFindings;
  return { workspace, runtime, agents, turns, settle, withCard, cardOf };
}

describe('a sidebar about a finding', () => {
  it('copies the conversation with the agent\'s own fork, read only in the same worktree, and leaves the finding as it was', async () => {
    const w = await world();
    const main = await w.withCard();
    const aside = await w.runtime.asides.open(main.id, aboutFinding(1));
    expect(aside.aside).toEqual({ sessionId: main.id, at: CARD, key: findingAsideKey(CARD, 'f1'), name: 'Finding #1', summary: 'Drafts are deleted after a week.' });
    expect(w.agents.forks).toHaveLength(1);
    const state = await w.workspace.state();
    const row = state.sessions.find((s) => s.id === main.id)!;
    expect(w.agents.forks[0]).toMatchObject({ from: row.worktreePath, to: row.worktreePath });
    const detail = await w.workspace.storedDetail(aside.id);
    expect(detail?.settings?.permission).toBe('readonly');
    expect(detail?.guest).toEqual({ hostId: main.id, role: 'review', writes: false });
    expect(detail?.inbox?.[0]).toContain('This is a sidebar');
    expect(detail?.inbox?.[0]).toContain('The finding:\n\nFinding 1 · High priority · Blocks. Drafts are deleted after a week.');
    expect(await w.cardOf(main.id)).toEqual(round);
  });

  it('is one per finding, and is kept apart from the sidebar and the trees', async () => {
    const w = await world();
    const main = await w.withCard();
    const [a, b] = await Promise.all([w.runtime.asides.open(main.id, aboutFinding(1)), w.runtime.asides.open(main.id, aboutFinding(1))]);
    expect(a.id).toBe(b.id);
    expect((await w.runtime.asides.open(main.id, aboutFinding(1))).id).toBe(a.id);
    const other = await w.runtime.asides.open(main.id, aboutFinding(2));
    expect(other.id).not.toBe(a.id);
    expect(w.agents.forks).toHaveLength(2);
    const state = await w.workspace.state();
    expect(state.sessions.find((s) => s.id === a.id)?.filing.status).toBe('hidden');
    expect(state.links.some((l) => l.childId === a.id)).toBe(false);
  });

  it('refuses with the reason: a point not in the conversation, a sidebar of a sidebar, and an agent that cannot fork', async () => {
    const w = await world();
    const main = await w.withCard();
    await expect(w.runtime.asides.open(main.id, { at: 'nope' })).rejects.toThrow('That point is no longer in this conversation.');
    const aside = await w.runtime.asides.open(main.id, aboutFinding(1));
    await expect(w.runtime.asides.open(aside.id, aboutFinding(1))).rejects.toThrow('has no sidebars of its own');
    const open = await w.withCard('opencode');
    await expect(w.runtime.asides.open(open.id, aboutFinding(1))).rejects.toThrow('OpenCode cannot fork a conversation');
  });

  it('says why when the agent could not copy the conversation', async () => {
    const w = await world();
    const main = await w.withCard();
    w.agents.forkFailure = 'session file missing';
    await expect(w.runtime.asides.open(main.id, aboutFinding(1))).rejects.toThrow('The agent could not copy the conversation: session file missing');
  });

  it('only talks: a Kestrel tool that starts or changes something is refused there', async () => {
    const w = await world();
    const main = await w.withCard();
    const aside = await w.runtime.asides.open(main.id, aboutFinding(1));
    await w.runtime.reply(aside.id, 'Why is this blocking?');
    await w.settle();
    const turn = w.turns.at(-1)!;
    expect(turn.text).toContain('This is a sidebar');
    const answer = await turn.options.tools.spawn({ project: 'repo', brief: 'Do it' } as never);
    expect(answer).toEqual({ text: ASIDE_TOOL_REFUSAL, isError: true });
  });

  it('goes when the session it is about is deleted', async () => {
    const w = await world();
    const main = await w.withCard();
    const aside = await w.runtime.asides.open(main.id, aboutFinding(1));
    await w.workspace.deleteSession(main.id);
    expect((await w.workspace.state()).sessions.some((s) => s.id === aside.id)).toBe(false);
  });
});

describe('acting on a finding', () => {
  it('answers the reviewer\'s question once, as the user\'s message, and marks the card', async () => {
    const w = await world();
    const main = await w.withCard();
    const f = await w.runtime.findingActions.act(main.id, CARD, 'f1', 'answer', ' Archive them. ');
    expect(f.answer).toBe('Archive them.');
    await w.settle();
    expect(w.turns.at(-1)!.text).toContain('My answer: Archive them.');
    expect((await w.cardOf(main.id))?.findings[0]?.answer).toBe('Archive them.');
    await expect(w.runtime.findingActions.act(main.id, CARD, 'f1', 'answer', 'Again')).rejects.toThrow('answered already');
    await expect(w.runtime.findingActions.act(main.id, CARD, 'f2', 'answer', 'x')).rejects.toThrow('asks no question');
  });

  it('asks for a fix once, and dismisses and takes back without sending anything', async () => {
    const w = await world();
    const main = await w.withCard();
    await w.runtime.findingActions.act(main.id, CARD, 'f2', 'fix');
    await w.settle();
    expect(w.turns.at(-1)!.text).toContain("Please fix this finding from Astra's review");
    await expect(w.runtime.findingActions.act(main.id, CARD, 'f2', 'fix')).rejects.toThrow('asked for already');
    const sent = w.turns.length;
    await w.runtime.findingActions.act(main.id, CARD, 'f1', 'dismiss');
    expect((await w.cardOf(main.id))?.findings[0]?.dismissed).toBe(true);
    await expect(w.runtime.findingActions.act(main.id, CARD, 'f1', 'fix')).rejects.toThrow('was dismissed');
    await w.runtime.findingActions.act(main.id, CARD, 'f1', 'restore');
    expect((await w.cardOf(main.id))?.findings[0]?.dismissed).toBeUndefined();
    expect(w.turns.length).toBe(sent);
  });
});

describe('a sidebar from any point of a conversation', () => {
  it('starts from a message with no subject, speaking of that point, one per point', async () => {
    const w = await world();
    const main = await w.withCard();
    const said = w.runtime.overlay(main.id)!.messages.find((m) => m.author === 'you')!;
    const aside = await w.runtime.asides.open(main.id, { at: said.id! });
    expect(aside.aside).toEqual({ sessionId: main.id, at: said.id, key: `point:${said.id}`, summary: 'Build it' });
    expect(aside.title).toBe('Sidebar: Build it');
    expect((await w.workspace.storedDetail(aside.id))?.inbox?.[0]).toContain('about this point in the conversation');
    expect((await w.runtime.asides.open(main.id, { at: said.id! })).id).toBe(aside.id);
  });

  it('copies the conversation as it was at that point: cut at the end of the turn it is in', async () => {
    const w = await world();
    const main = await w.withCard();
    const first = w.runtime.overlay(main.id)!.messages.find((m) => m.author === 'you')!;
    await w.runtime.reply(main.id, 'And another thing');
    await w.settle();
    await w.runtime.asides.open(main.id, { at: first.id! });
    // The fake agent records no point for its turns: the whole conversation is copied, and the sidebar is told.
    const aside = (await w.workspace.state()).sessions.find((s) => s.aside?.at === first.id)!;
    expect(aside.aside?.whole).toBe(true);
    expect((await w.workspace.storedDetail(aside.id))?.inbox?.[0]).toContain('runs past that point');
  });
});

describe('where the copy a sidebar holds ends', () => {
  const m = (id: string, author: 'you' | 'agent', point?: string) => ({ id, author, time: '', text: id, ...(point ? { forkPoint: point } : {}) }) as never;
  it('at the end of an earlier turn, at the end for the latest, refused while the latest is still running', () => {
    const messages = [m('u1', 'you'), m('a1', 'agent'), m('u2', 'you'), m('a2', 'agent')];
    expect(asideCut(messages, 'a2', false, 'T')).toEqual({});
    expect(() => asideCut(messages, 'a2', true, 'T')).toThrow('still on the turn this point is in');
    expect(() => asideCut(messages, 'gone', false, 'T')).toThrow('no longer in this conversation');
    expect(asideCut([m('u1', 'you', 'p1'), m('a1', 'agent'), m('u2', 'you'), m('a2', 'agent')], 'a1', true, 'T')).toEqual({ at: 'p1' });
    expect(asideCut(messages, 'a1', false, 'T')).toEqual({ whole: true });
    expect(() => asideCut(messages, 'a1', true, 'T')).toThrow('no record of where that turn ends');
  });
});
