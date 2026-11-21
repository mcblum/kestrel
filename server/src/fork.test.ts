// Fork: a new session that carries on from a copy of another's conversation, through a real runtime
// with a scripted agent and real repositories and worktrees.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { SessionRuntime } from './runtime.ts';
import { FakeAgents, until, type Turn } from './test-agent.ts';
import { makeRepo } from './test-repo.ts';
import { buildTree } from './tree.ts';
import { Refused, Workspace } from './workspace.ts';
import type { Session } from './model.ts';

// Real repositories and worktrees: slow under a full parallel run (see delegation.test.ts).
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

const SPLIT = 'split the work';
const HOLD = 'hold this turn';
const LAST_WORD = 'Shipped PDF invoices in A and B.';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function world(opts: { forks?: boolean } = {}) {
  const workspace = new Workspace(memoryPersistence());
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-fork-')));
  const agents = new FakeAgents();
  const adapter = agents.adapter();
  const runtime = new SessionRuntime(workspace, { claude: opts.forks === false ? { ...adapter, fork: undefined } : adapter }, data);
  const repoA = makeRepo();
  const a = await runtime.registerProject(repoA, 'repoA');
  await runtime.registerProject(makeRepo(), 'repoB');
  let release: () => void = () => undefined;
  agents.script = async (turn: Turn) => {
    if (turn.text === SPLIT) {
      await turn.options.tools.delegate({ tasks: [{ project: 'repoB', brief: 'Change B' }], name: 'Invoices' });
      turn.emit({ type: 'message', id: 'last-word', text: LAST_WORD, delta: LAST_WORD, done: true });
    } else if (turn.text === HOLD) await new Promise<void>((resolve) => (release = resolve));
  };
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await agents.settled();
      for (const s of (await workspace.state()).sessions) await runtime.idle(s.id);
    }
  };
  return { workspace, runtime, agents, settle, repoA, a, data, release: () => release() };
}

type World = Awaited<ReturnType<typeof world>>;

/** A lead in repoA (Bypass, so no approval card) that delegated one task to repoB: a workstream of two. */
async function withWorkstream(w: World) {
  const lead = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: SPLIT, permission: 'bypass', model: 'opus' });
  await w.settle();
  return lead;
}

const sessionOf = async (w: World, id: string) => (await w.workspace.state()).sessions.find((s) => s.id === id)!;
const allWorkstreams = async (w: World) => {
  const state = await w.workspace.state();
  return [...state.workstreams, ...state.archivedWorkstreams];
};

/** Everything about a session another operation must leave alone: its row, its stored conversation, its links, its workstream. */
async function footprint(w: World, id: string) {
  const state = await w.workspace.state();
  return {
    session: state.sessions.find((s) => s.id === id),
    detail: await w.workspace.storedDetail(id),
    links: state.links.filter((l) => l.parentId === id || l.childId === id),
    workstreams: [...state.workstreams, ...state.archivedWorkstreams].filter((x) => x.sessionIds.includes(id)),
  };
}

describe('forking a session', () => {
  it('makes a new session with a copy of the conversation, in the same project with the same agent, model and mode', async () => {
    const w = await world();
    const lead = await withWorkstream(w);
    const old = await w.workspace.storedDetail(lead.id);
    const fork = await w.runtime.forks.fork(lead.id);
    const state = await w.workspace.state();
    expect(fork).toMatchObject({ title: `${lead.title} (fork)`, agent: 'claude', startedIn: w.a.id, state: 'done' });
    const copied = await w.workspace.storedDetail(fork.id);
    expect(copied!.messages).toEqual(old!.messages);
    expect(copied!.settings).toEqual({ model: 'opus', permission: 'bypass' });
    // The agent's own fork of the old conversation, looked up where it was held, working in the fork's worktree.
    expect(w.agents.forks).toEqual([{ id: old!.agentSessionId, from: (await sessionOf(w, lead.id)).worktreePath, to: fork.worktreePath, forkedId: copied!.agentSessionId }]);
    expect(state.links).toContainEqual(expect.objectContaining({ parentId: lead.id, childId: fork.id, kind: 'fork' }));
  });

  it('gets its own worktree, cut from the old branch as it stands, commits included; uncommitted changes stay behind and the fork says so', async () => {
    const w = await world();
    const lead = await withWorkstream(w);
    const oldTree = (await sessionOf(w, lead.id)).worktreePath!;
    writeFileSync(join(oldTree, 'committed.txt'), 'kept\n');
    git(oldTree, 'add', '.');
    git(oldTree, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'work');
    writeFileSync(join(oldTree, 'loose.txt'), 'not committed\n');
    const fork = await w.runtime.forks.fork(lead.id);
    expect(fork.worktreePath).not.toBe(oldTree);
    expect(fork.branch).not.toBe((await sessionOf(w, lead.id)).branch);
    expect(git(fork.worktreePath!, 'rev-parse', 'HEAD')).toBe(git(oldTree, 'rev-parse', 'HEAD'));
    expect(readFileSync(join(fork.worktreePath!, 'committed.txt'), 'utf8')).toBe('kept\n');
    expect(existsSync(join(fork.worktreePath!, 'loose.txt'))).toBe(false);
    // Its base is the old session's, so its changes read the same.
    expect(git(fork.worktreePath!, 'config', '--get', `branch.${fork.branch}.kestrelbase`)).toBe(git(oldTree, 'config', '--get', `branch.${(await sessionOf(w, lead.id)).branch}.kestrelbase`));
    const last = (await w.workspace.storedDetail(fork.id))!.messages.at(-1)!;
    expect(last).toMatchObject({ author: 'agent', notice: 'info', text: expect.stringMatching(/had 1 uncommitted change in its worktree/) });
    // The old worktree still has it.
    expect(existsSync(join(oldTree, 'loose.txt'))).toBe(true);
  });

  it('leaves the old session, its links and its workstream exactly as they were, a complete and archived one included', async () => {
    const w = await world();
    const lead = await withWorkstream(w);
    const workstream = (await allWorkstreams(w))[0]!;
    await w.workspace.setWorkstreamStatus(workstream.id, 'complete');
    await w.workspace.archiveWorkstream(workstream.id);
    const before = await footprint(w, lead.id);
    const fork = await w.runtime.forks.fork(lead.id);
    const after = await footprint(w, lead.id);
    expect({ ...after, links: after.links.filter((l) => l.childId !== fork.id) }).toEqual(before);
    // The fork is in no workstream, and a message the user then sends in it does not bring the old one back.
    expect((await allWorkstreams(w)).some((x) => x.sessionIds.includes(fork.id))).toBe(false);
    await w.runtime.reply(fork.id, 'go on');
    await w.settle();
    expect(await footprint(w, lead.id)).toEqual(after);
    // That message ran on the forked conversation.
    const forkedId = (await w.workspace.storedDetail(fork.id))!.agentSessionId;
    expect(w.agents.resumes.map((r) => r.id)).toContain(forkedId);
  });

  it('is refused while the old session is running a turn', async () => {
    const w = await world();
    const s = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: HOLD });
    await until(async () => w.agents.turns.length === 1, 'the turn to start');
    await expect(w.runtime.forks.fork(s.id)).rejects.toThrow(/Wait for the turn to end/);
    w.release();
    await w.settle();
  });

  it('is refused for an agent Kestrel cannot fork with, saying why, and makes nothing', async () => {
    const w = await world({ forks: false });
    const s = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'hello' });
    await w.settle();
    const count = (await w.workspace.state()).sessions.length;
    await expect(w.runtime.forks.fork(s.id)).rejects.toThrow(/Claude in Kestrel cannot fork a conversation/);
    expect((await w.workspace.state()).sessions.length).toBe(count);
  });

  it('a failed agent-side fork leaves nothing behind: no session, no link, no worktree; trying again makes none either', async () => {
    const w = await world();
    const s = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'hello' });
    await w.settle();
    const before = await w.workspace.state();
    const branches = git(w.repoA, 'branch', '--list');
    w.agents.forkFailure = 'Session not found';
    for (let i = 0; i < 2; i++) await expect(w.runtime.forks.fork(s.id)).rejects.toThrow(/could not fork the conversation: Session not found/);
    const after = await w.workspace.state();
    expect(after.sessions.map((x) => x.id)).toEqual(before.sessions.map((x) => x.id));
    expect(after.links).toEqual(before.links);
    expect(git(w.repoA, 'branch', '--list')).toBe(branches);
    expect(git(w.repoA, 'worktree', 'list').split('\n')).toHaveLength(2);
  });

  it('in a plain folder: follows the one-editing-session rule, and otherwise works in the same folder', async () => {
    const w = await world();
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-plain-')));
    const project = await w.runtime.registerProject(plain, 'plain');
    const idle = await w.runtime.start({ agent: 'claude', projectId: project.id, prompt: 'hello' });
    await w.settle();
    const fork = await w.runtime.forks.fork(idle.id);
    expect(fork).toMatchObject({ startedIn: project.id, worktreePath: null, branch: null });
    expect(w.agents.forks.at(-1)).toMatchObject({ from: plain, to: plain });
    await w.runtime.start({ agent: 'claude', projectId: project.id, prompt: HOLD });
    await until(async () => w.agents.turns.some((t) => t.text === HOLD), 'the other session to work');
    await expect(w.runtime.forks.fork(idle.id)).rejects.toThrow(/is a plain folder and .* is already editing it/);
    w.release();
    await w.settle();
  });

  it('a session with no project forks into another read-only session with no project', async () => {
    const w = await world();
    const s = await w.runtime.start({ agent: 'claude', projectId: null, prompt: 'hello', permission: 'readonly' });
    await w.settle();
    const fork = await w.runtime.forks.fork(s.id);
    expect(fork).toMatchObject({ startedIn: null, worktreePath: null });
    expect(w.agents.forks.at(-1)).toMatchObject({ from: join(w.data, 'scratch'), to: join(w.data, 'scratch') });
    expect((await w.workspace.storedDetail(fork.id))!.settings).toMatchObject({ permission: 'readonly' });
  });

  it('is refused for a session whose agent never started, with the reason', async () => {
    const w = await world();
    const stored = await w.workspace.addSession({ id: 'stored', title: 'Sample', agent: 'claude', startedIn: w.a.id, state: 'done' });
    await expect(w.runtime.forks.fork(stored.id)).rejects.toBeInstanceOf(Refused);
    await expect(w.runtime.forks.fork('nope')).rejects.toThrow(/No such session/);
  });
});

describe('a fork in lineage', () => {
  it('shows as “forked” in both sessions’ trails, and is not drawn under the old session', async () => {
    const w = await world();
    const s = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'hello' });
    await w.settle();
    const fork = await w.runtime.forks.fork(s.id);
    const forkTrail = (await w.workspace.detail(fork.id))!.trail;
    expect(forkTrail.map((e) => [e.sessionId, e.via])).toEqual([[s.id, null], [fork.id, 'fork']]);
    expect((await w.workspace.detail(s.id))!.trail.map((e) => [e.sessionId, e.via])).toEqual([[s.id, null], [fork.id, 'fork']]);
    const state = await w.workspace.state();
    const roots = buildTree([s.id, fork.id], state.links);
    expect(roots.map((n) => [n.sessionId, n.children.length, n.movedFrom])).toEqual([[s.id, 0, null], [fork.id, 0, null]]);
    expect(state.sessions.find((x) => x.id === fork.id)!.filing.status).toBe('started');
  });

  it('Stop all on the old session’s workstream leaves the fork running; the fork is not confined like a child', async () => {
    const w = await world();
    const lead = await withWorkstream(w);
    const fork: Session = await w.runtime.forks.fork(lead.id);
    void w.runtime.reply(fork.id, HOLD);
    await until(async () => w.agents.turns.some((t) => t.text === HOLD), 'the fork to work');
    const workstream = (await allWorkstreams(w))[0]!;
    await w.runtime.delegation.stopWorkstream(workstream.id);
    expect((await sessionOf(w, fork.id)).state).toBe('running');
    // Same mode as the old session (Bypass), not a child's; its commands are not held to its worktree.
    const resumed = w.agents.resumes.find((r) => r.id === (w.agents.forks.at(-1)!.forkedId))!;
    expect(resumed.options.permission).toBe('bypass');
    expect(resumed.options.confineShell).toBeUndefined();
    w.release();
    await w.settle();
  });
});

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** A session of three turns. Each turn says where it ends, as a real agent does, except the one named `pointless`; the second shows a picture. */
async function threeTurns(w: World, pointless?: string) {
  w.agents.script = async (turn: Turn) => {
    turn.emit({ type: 'message', id: `said-${turn.n}`, text: `Answer ${turn.n}`, delta: `Answer ${turn.n}`, done: true });
    if (turn.text === 'two') turn.emit({ type: 'image', id: 'shot-2', mediaType: 'image/png', data: PNG });
    if (turn.text !== pointless) turn.emit({ type: 'turn-point', point: `point-${turn.text}` });
  };
  const s = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'one' });
  await w.settle();
  for (const text of ['two', 'three']) {
    await w.runtime.reply(s.id, text);
    await w.settle();
  }
  const detail = (await w.workspace.storedDetail(s.id))!;
  const starter = (text: string) => detail.messages.find((m) => m.author === 'you' && m.text === text)!;
  return { s, detail, starter };
}

describe('forking from an earlier turn', () => {
  it('stores where each turn ends in the agent’s conversation, on the message that started it', async () => {
    const w = await world();
    const { starter } = await threeTurns(w);
    expect(['one', 'two', 'three'].map((t) => starter(t).forkPoint)).toEqual(['point-one', 'point-two', 'point-three']);
  });

  it('copies exactly the conversation through that turn, has the agent fork at that turn’s point, and says the files are as now', async () => {
    const w = await world();
    const { s, detail, starter } = await threeTurns(w);
    const before = await footprint(w, s.id);
    const fork = await w.runtime.forks.fork(s.id, starter('one').id);
    const copied = (await w.workspace.storedDetail(fork.id))!.messages;
    const through = detail.messages.slice(0, detail.messages.indexOf(starter('two')));
    expect(copied.slice(0, -1).map((m) => m.id)).toEqual(through.map((m) => m.id));
    expect(copied.slice(0, -1)).toEqual(through.map(({ forkPoint: _p, ...m }) => m));
    expect(copied.at(-1)).toMatchObject({ notice: 'info', text: expect.stringMatching(/starts from that turn; the files are as they are now/) });
    expect(w.agents.forks.at(-1)).toMatchObject({ id: detail.agentSessionId, at: 'point-one' });
    // The picture of the second turn is not the fork's: it is not copied.
    expect(existsSync(join(w.data, 'media', fork.id))).toBe(false);
    // The old session is exactly as it was.
    const after = await footprint(w, s.id);
    expect({ ...after, links: after.links.filter((l) => l.childId !== fork.id) }).toEqual(before);
  });

  it('copies the pictures of the turns it keeps', async () => {
    const w = await world();
    const { s, starter } = await threeTurns(w);
    const fork = await w.runtime.forks.fork(s.id, starter('two').id);
    const names = (await w.workspace.storedDetail(fork.id))!.messages.flatMap((m) => m.images ?? []);
    expect(names).toHaveLength(1);
    expect(existsSync(join(w.data, 'media', fork.id, names[0]!))).toBe(true);
  });

  it('from the last turn behaves as forking from the end: the whole conversation, no point, no notice', async () => {
    const w = await world();
    const { s, detail, starter } = await threeTurns(w);
    const fork = await w.runtime.forks.fork(s.id, starter('three').id);
    const copied = (await w.workspace.storedDetail(fork.id))!.messages;
    expect(copied.map((m) => m.id)).toEqual(detail.messages.map((m) => m.id));
    expect(w.agents.forks.at(-1)!).not.toHaveProperty('at');
    // The copy keeps no points: the agent's copy has ids of its own.
    expect(copied.some((m) => m.forkPoint)).toBe(false);
  });

  it('refuses a turn with no point, with the reason, and makes nothing', async () => {
    const w = await world();
    const { s, starter } = await threeTurns(w, 'two');
    const count = (await w.workspace.state()).sessions.length;
    await expect(w.runtime.forks.fork(s.id, starter('two').id)).rejects.toThrow(/no record of where this turn ends .* Fork from a later turn/);
    await expect(w.runtime.forks.fork(s.id, 'no-such-message')).rejects.toThrow(/That turn is not in the conversation/);
    expect((await w.workspace.state()).sessions.length).toBe(count);
    expect(w.agents.forks).toHaveLength(0);
  });
});
