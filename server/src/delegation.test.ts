import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import type { DetectDeps } from './commit-signing/detect.ts';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import type { InputRequest } from './agents/types.ts';
import { DEFAULT_LIMITS } from './limits.ts';
import { REPORT_MAX, reportOf } from './delegation.ts';
import type { PermissionLevel } from './shared/permissions.ts';
import { PROTECTED_REFUSAL } from './shared/protected-files.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { SessionRuntime } from './runtime.ts';
import { FakeAgents, until, type Turn } from './test-agent.ts';
import { makeRepo } from './test-repo.ts';
import { Workspace } from './workspace.ts';

// Every test here makes real repositories and worktrees and starts sessions in them. Alone each
// takes about a second, but the whole suite runs many files at once and they have gone past the
// default 5 seconds under that load, failing for no reason of their own.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

/** git and gpgconf as a fake: the repository signs with GnuPG, or (`signs: false`) does not. Nothing real is asked. */
const signingMachine = (signs: boolean): DetectDeps => ({
  home: '/Users/me',
  exists: () => true,
  run: async (file, args) => (file === 'gpgconf' ? 'homedir:/Users/me/.gnupg\nagent-socket:/Users/me/.gnupg/S.gpg-agent\n' : args.at(-1) === 'commit.gpgsign' && signs ? 'true\n' : null),
});

async function world(signs = false) {
  const db = memoryPersistence();
  const workspace = new Workspace(db);
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-del-')));
  const agents = new FakeAgents();
  const runtime = new SessionRuntime(workspace, { claude: agents.adapter() }, data, { commitSigning: { detect: signingMachine(signs) } });
  const a = await runtime.registerProject(makeRepo(), 'repoA');
  const b = await runtime.registerProject(makeRepo(), 'repoB');
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await agents.settled();
      for (const s of (await workspace.state()).sessions) await runtime.idle(s.id);
    }
  };
  const session = async (id: string) => (await workspace.state()).sessions.find((s) => s.id === id)!;
  const card = (id: string): InputRequest | undefined => runtime.overlay(id)?.messages.find((m) => m.input && !m.input.resolved)?.input as InputRequest | undefined;
  const answer = (id: string, optionId: 'allow' | 'deny') => runtime.answer(id, card(id)!.id, { optionId });
  const children = async (parentId: string) => {
    const s = await workspace.state();
    return s.links.filter((l) => l.parentId === parentId).map((l) => ({ link: l, session: s.sessions.find((x) => x.id === l.childId)! }));
  };
  const toolText = new Map<string, string>();
  const call = (turn: Turn, key: string, run: () => Promise<{ text: string; isError?: boolean }>) => run().then((r) => (toolText.set(key, r.text), r));
  return { db, workspace, data, agents, runtime, a, b, settle, session, card, answer, children, toolText, call };
}

const writeFile = (turn: Turn, name = 'change.txt') => {
  writeFileSync(join(turn.options.directory, name), 'x\n');
  turn.emit({ type: 'files-changed', paths: [] });
};

describe('handoff', () => {
  it('from a session with no project: a linked child starts in the target project with the summary', async () => {
    const w = await world();
    w.agents.script = async (turn) => {
      if (turn.text === 'The bug is in B') await w.call(turn, 'handoff', () => turn.options.tools.handoff({ project: 'repoB', summary: 'Fix the null check in B.\nIt crashes on empty input.' }));
    };
    const parent = await w.runtime.start({ agent: 'claude', projectId: null, prompt: 'The bug is in B' });
    await w.settle();
    const [child] = await w.children(parent.id);
    expect(child!.link.kind).toBe('handoff');
    expect(child!.session).toMatchObject({ startedIn: w.b.id, title: 'Fix the null check in B.', landedIn: null, filing: { status: 'pending', projectId: w.b.id } });
    // The summary is the child's first message; it runs in its own worktree, in Manual (its parent has no project and cannot edit).
    const start = w.agents.starts.find((s) => s.prompt.startsWith('Fix the null check'))!;
    expect(start.prompt).toBe('Fix the null check in B.\nIt crashes on empty input.');
    expect(start.options).toMatchObject({ permission: 'ask' });
    // Its shell commands are held to that worktree too; the session that started it is not a child.
    expect(start.options.confineShell).toBe(true);
    expect(w.agents.starts.find((s) => s.prompt === 'The bug is in B')!.options.confineShell).toBeUndefined();
    expect(start.options.directory.startsWith(join(w.data, 'worktrees'))).toBe(true);
    expect(start.options.instruction).toMatch(/started by a handoff/);
    // The caller is told where it went and to stop.
    expect(w.toolText.get('handoff')).toMatch(/repoB/);
    expect(w.toolText.get('handoff')).toMatch(/Stop working on it here/);
    // The parent changed nothing: it is not listed in any project and shows as handed off.
    const p = await w.session(parent.id);
    expect(p.filing.status).toBe('hidden');
    expect(p).toMatchObject({ state: 'done', note: 'Handed off' });
  });

  it('is filed under the target project once the child changes something; the parent stays hidden', async () => {
    const w = await world();
    w.agents.script = async (turn) => {
      if (turn.text === 'look') await turn.options.tools.handoff({ project: 'repoB', summary: 'Do it in B' });
      else writeFile(turn);
    };
    const parent = await w.runtime.start({ agent: 'claude', projectId: null, prompt: 'look' });
    await w.settle();
    const [child] = await w.children(parent.id);
    expect(child!.session).toMatchObject({ landedIn: w.b.id, filing: { status: 'landed', projectId: w.b.id } });
    expect((await w.session(parent.id)).filing.status).toBe('hidden');
  });

  it('a parent that changed something before handing off stays under its own project (parent rules win)', async () => {
    const w = await world();
    w.agents.script = async (turn) => {
      if (turn.text === 'work') {
        writeFile(turn, 'mine.txt');
        await turn.options.tools.handoff({ project: 'repoB', summary: 'The rest is in B' });
      }
    };
    const parent = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'work' });
    await w.settle();
    expect(await w.session(parent.id)).toMatchObject({ landedIn: w.a.id, filing: { status: 'landed', projectId: w.a.id } });
    const [child] = await w.children(parent.id);
    expect(child!.session.filing).toMatchObject({ status: 'pending', projectId: w.b.id });
  });

  it('puts the child in the caller\'s folder', async () => {
    const w = await world();
    const folder = await w.workspace.addGroup('Release');
    w.agents.script = async (turn) => {
      if (turn.text === 'go') await turn.options.tools.handoff({ project: 'repoB', summary: 'in B' });
    };
    const parent = await w.runtime.start({ agent: 'claude', projectId: null, prompt: 'go', groupId: folder.id });
    await w.settle();
    expect((await w.children(parent.id))[0]!.session.groupId).toBe(folder.id);
  });

  it('refuses a handoff to the project the caller is editing in, but allows it from a read-only session', async () => {
    const w = await world();
    const results: Record<string, string> = {};
    w.agents.script = async (turn) => {
      if (turn.text === 'edit' || turn.text === 'read') results[turn.text] = (await turn.options.tools.handoff({ project: 'repoA', summary: 'x' })).text;
    };
    await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'edit' });
    await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'read', permission: 'readonly' });
    await w.settle();
    expect(results.edit).toMatch(/already working in repoA/);
    expect(results.read).toMatch(/Handed off to repoA/);
  });

  it('shows a refusal in the caller\'s conversation as well as returning it', async () => {
    const w = await world();
    w.agents.script = async (turn) => {
      await turn.options.tools.handoff({ project: 'nowhere', summary: 'x' });
    };
    const s = await w.runtime.start({ agent: 'claude', projectId: null, prompt: 'go' });
    await w.settle();
    expect(w.runtime.overlay(s.id)!.messages.find((m) => m.notice === 'error')!.text).toMatch(/Kestrel refused handoff: No registered project "nowhere"/);
  });
});

describe('matching the project an agent names', () => {
  it('accepts a name in any case or a path, and lists the valid ones for an unknown name', async () => {
    const w = await world();
    const out: string[] = [];
    w.agents.script = async (turn) => {
      if (turn.text !== 'go') return;
      for (const project of ['REPOB', w.b.folders[0]!.path, 'repo-c']) out.push((await turn.options.tools.handoff({ project, summary: `to ${project}` })).text);
    };
    await w.runtime.start({ agent: 'claude', projectId: null, prompt: 'go' });
    await w.settle();
    expect(out[0]).toMatch(/Handed off to repoB/);
    expect(out[1]).toMatch(/Handed off to repoB/);
    expect(out[2]).toMatch(/No registered project "repo-c"\. Valid projects: repoA \(.+\); repoB \(.+\)\./);
  });
});

describe('delegate', () => {
  async function delegating(w: Awaited<ReturnType<typeof world>>, opts: { permission?: PermissionLevel; groupId?: string } = {}) {
    w.agents.script = async (turn) => {
      if (turn.text === 'both') {
        await w.call(turn, 'delegate', () =>
          turn.options.tools.delegate({ tasks: [{ project: 'repoA', brief: 'Change A\nwith details' }, { project: 'repoB', brief: 'Change B' }] }),
        );
      } else writeFile(turn);
    };
    return w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'both', ...opts });
  }

  it('asks first, showing exactly what would start, and starts nothing until approved', async () => {
    const w = await world();
    const parent = await delegating(w);
    await until(() => w.card(parent.id) !== undefined, 'approval card');
    const card = w.card(parent.id)!;
    expect(card).toMatchObject({ kind: 'approval', tool: 'delegate', title: 'Start 2 sessions' });
    expect(card.detail).toContain('repoA · claude');
    expect(card.detail).toContain('Change A');
    expect(card.detail).toContain('repoB · claude');
    expect((await w.session(parent.id)).state).toBe('attention');
    expect(await w.children(parent.id)).toHaveLength(0);
    await w.answer(parent.id, 'allow');
    await w.settle();
    expect(await w.children(parent.id)).toHaveLength(2);
  });

  it('links each child as a delegate, moves nothing, and connects a split across projects with a workstream', async () => {
    const w = await world();
    const parent = await delegating(w, { permission: 'edits' });
    await until(() => w.card(parent.id) !== undefined);
    await w.answer(parent.id, 'allow');
    await w.settle();
    const state = await w.workspace.state();
    const kids = await w.children(parent.id);
    expect(kids.map((k) => k.link.kind)).toEqual(['delegate', 'delegate']);
    // No group is made and nobody is moved: the caller and the children stay filed where they are.
    expect(state.groups).toEqual([]);
    expect((await w.session(parent.id)).groupId).toBeNull();
    expect(kids.every((k) => k.session.groupId === null)).toBe(true);
    // The split reaches repoB, so a workstream points at all three, and the caller's conversation says so.
    expect(state.workstreams).toHaveLength(1);
    expect(state.workstreams[0]!.sessionIds).toEqual([parent.id, ...kids.map((k) => k.session.id)]);
    // A workstream just made is given a colour (Settings → Colours).
    expect((await w.runtime.colours.current()).workstreams[state.workstreams[0]!.id]).toBe('brown');
    expect(w.runtime.overlay(parent.id)!.messages.find((m) => m.notice)?.text).toMatch(/^Created the workstream “.+” to connect this session with repoA · Change A and repoB · Change B\.$/);
    // Children ask before edits, in their own worktrees, whatever the caller's level was.
    const childStarts = w.agents.starts.filter((s) => s.prompt.startsWith('Change'));
    // The children run in the caller's mode (Accept edits here).
    expect(childStarts.map((s) => s.options.permission)).toEqual(['edits', 'edits']);
    expect(new Set(childStarts.map((s) => s.options.directory)).size).toBe(2);
    expect(childStarts[0]!.options.instruction).toMatch(/started by a delegate call/);
    // The tool result lists the children's ids and titles.
    const text = w.toolText.get('delegate')!;
    for (const k of kids) expect(text).toContain(k.session.id);
    expect(text).toContain('Change A');
    // Filed under where their work landed.
    expect(kids.map((k) => k.session.filing.projectId).sort()).toEqual([w.a.id, w.b.id].sort());
  });

  it('starts nothing when declined and tells the agent', async () => {
    const w = await world();
    const parent = await delegating(w);
    await until(() => w.card(parent.id) !== undefined);
    await w.answer(parent.id, 'deny');
    await w.settle();
    expect(await w.children(parent.id)).toHaveLength(0);
    expect(w.toolText.get('delegate')).toMatch(/declined/);
  });

  for (const permission of ['auto', 'bypass'] as const) {
    it(`runs without a card when the caller is in ${permission} mode; the children run in Auto, never Bypass`, async () => {
      const w = await world();
      const parent = await delegating(w, { permission });
      await w.settle();
      expect(w.card(parent.id)).toBeUndefined();
      expect(await w.children(parent.id)).toHaveLength(2);
      expect(w.agents.starts.filter((s) => s.prompt.startsWith('Change')).map((s) => s.options.permission)).toEqual(['auto', 'auto']);
    });
  }

  it("starts the children in the caller's mode once the user allows the delegate", async () => {
    const w = await world();
    const parent = await delegating(w, { permission: 'edits' });
    await until(() => w.card(parent.id) !== undefined, 'approval card');
    await w.answer(parent.id, 'allow');
    await w.settle();
    expect(w.agents.starts.filter((s) => s.prompt.startsWith('Change')).map((s) => s.options.permission)).toEqual(['edits', 'edits']);
  });

  for (const permission of ['ask', 'edits', 'plan'] as const) {
    it(`asks first when the caller is in ${permission} mode`, async () => {
      const w = await world();
      const parent = await delegating(w, { permission });
      await until(() => w.card(parent.id) !== undefined, 'approval card');
      expect(w.card(parent.id)).toMatchObject({ kind: 'approval', tool: 'delegate' });
      expect(await w.children(parent.id)).toHaveLength(0);
    });
  }
});

describe('spawn', () => {
  it('starts an unrelated session after approval: no link, not in the caller\'s folder, in the caller\'s mode', async () => {
    const w = await world();
    const folder = await w.workspace.addGroup('Mine');
    w.agents.script = async (turn) => {
      if (turn.text === 'go') await turn.options.tools.spawn({ project: 'repoB', brief: 'Unrelated chore in B' });
    };
    const caller = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'go', groupId: folder.id, permission: 'edits' });
    await until(() => w.card(caller.id) !== undefined);
    expect(w.card(caller.id)).toMatchObject({ tool: 'spawn', detail: expect.stringContaining('repoB · claude') });
    await w.answer(caller.id, 'allow');
    await w.settle();
    const state = await w.workspace.state();
    expect(state.links).toHaveLength(0);
    const spawned = state.sessions.find((s) => s.title === 'Unrelated chore in B')!;
    expect(spawned).toMatchObject({ startedIn: w.b.id, groupId: null });
    expect(w.agents.starts.find((s) => s.prompt === 'Unrelated chore in B')!.options.permission).toBe('edits');
  });
});

describe('which modes start sessions without a card', () => {
  const spawning = (w: Awaited<ReturnType<typeof world>>, permission: PermissionLevel) => {
    w.agents.script = async (turn) => {
      if (turn.text === 'go') await w.call(turn, 'spawn', () => turn.options.tools.spawn({ project: 'repoB', brief: 'Chore in B' }));
    };
    return w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'go', permission });
  };

  for (const permission of ['auto', 'bypass'] as const) {
    it(`spawn starts at once from ${permission} mode, and the new session runs in Auto, never Bypass`, async () => {
      const w = await world();
      const caller = await spawning(w, permission);
      await w.settle();
      expect(w.card(caller.id)).toBeUndefined();
      expect(w.toolText.get('spawn')).toMatch(/^Started a separate session/);
      expect(w.agents.starts.find((s) => s.prompt === 'Chore in B')!.options.permission).toBe('auto');
    });
  }

  for (const permission of ['ask', 'edits', 'plan'] as const) {
    it(`spawn asks first from ${permission} mode`, async () => {
      const w = await world();
      const caller = await spawning(w, permission);
      await until(() => w.card(caller.id) !== undefined, 'approval card');
      expect(w.card(caller.id)).toMatchObject({ kind: 'approval', tool: 'spawn' });
      expect(w.agents.starts.some((s) => s.prompt === 'Chore in B')).toBe(false);
    });
  }

  it('add_project still asks in auto mode', async () => {
    const w = await world();
    w.agents.script = async (turn) => {
      if (turn.text === 'go') await turn.options.tools.addProject({ path: makeRepo() });
    };
    const caller = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'go', permission: 'auto' });
    await until(() => w.card(caller.id) !== undefined, 'approval card');
    expect(w.card(caller.id)).toMatchObject({ kind: 'approval', tool: 'add_project' });
    await w.answer(caller.id, 'deny');
    await w.settle();
  });
});

describe('limits', () => {
  it('refuses more than 5 tasks, shows the refusal, and asks nothing', async () => {
    const w = await world();
    let text = '';
    w.agents.script = async (turn) => {
      if (turn.text === 'go') text = (await turn.options.tools.delegate({ tasks: Array.from({ length: DEFAULT_LIMITS.maxChildrenPerDelegate + 1 }, (_, i) => ({ project: 'repoA', brief: `t${i}` })) })).text;
    };
    const s = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'go' });
    await w.settle();
    expect(text).toMatch(/at most 5 tasks; got 6/);
    expect(w.runtime.overlay(s.id)!.messages.some((m) => m.notice === 'error' && /refused delegate/.test(m.text))).toBe(true);
    expect(w.card(s.id)).toBeUndefined();
  });

  it('refuses a tree deeper than 2 levels', async () => {
    const w = await world();
    const answers: string[] = [];
    w.agents.script = async (turn) => {
      const level = /^L(\d)/.exec(turn.text)?.[1];
      if (level === undefined) return;
      answers.push(`${level}:${(await turn.options.tools.delegate({ tasks: [{ project: 'repoB', brief: `L${Number(level) + 1} child` }] })).text.slice(0, 90)}`);
    };
    const root = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'L0 root', permission: 'auto' });
    // A child runs in its caller's mode, so in Auto the whole chain starts without a card: the limit is what stops it.
    await w.settle();
    expect(root.id).toBeDefined();
    expect(answers[0]).toMatch(/^0:Started 1 session/);
    expect(answers[1]).toMatch(/^1:Started 1 session/);
    expect(answers[2]).toMatch(/^2:A session tree can be at most 2 levels deep/);
  });

  it('checks a tool call against the limits set in Settings → Workflow, stating the number in force', async () => {
    const w = await world();
    await w.workspace.limits.set({ maxChildrenPerDelegate: 2, maxDepth: 2, maxLiveSessionsPerTree: 10 });
    let text = '';
    w.agents.script = async (turn) => {
      if (turn.text === 'go') text = (await turn.options.tools.delegate({ tasks: Array.from({ length: 3 }, (_, i) => ({ project: 'repoA', brief: `t${i}` })) })).text;
    };
    await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'go' });
    await w.settle();
    expect(text).toMatch(/at most 2 tasks; got 3/);
  });

  it('refuses when the tree already has 10 live sessions', async () => {
    const w = await world();
    w.agents.hold = true; // sessions stay running
    const results: string[] = [];
    w.agents.script = async (turn) => {
      if (turn.text !== 'root') return;
      for (let i = 0; i < 3; i++) results.push((await turn.options.tools.delegate({ tasks: Array.from({ length: 4 }, (_, j) => ({ project: 'repoB', brief: `c${i}${j}` })) })).text.slice(0, 120));
    };
    const root = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'root', permission: 'auto' });
    await w.runtime.idle(root.id); // its worktree is made after start returns
    await w.agents.settled();
    // 1 root + 4 + 4 = 9 live; a third batch of 4 would make 13.
    expect(results[0]).toMatch(/^Started 4/);
    expect(results[1]).toMatch(/^Started 4/);
    expect(results[2]).toMatch(/at most 10 live sessions; this one has 9/);
  });
});

describe('hearing back from children', () => {
  async function orchestrated() {
    const w = await world();
    w.agents.script = async (turn) => {
      if (turn.text === 'both') await turn.options.tools.delegate({ tasks: [{ project: 'repoA', brief: 'Child A' }, { project: 'repoB', brief: 'Child B' }] });
      else if (turn.text.startsWith('Child')) writeFile(turn);
    };
    const parent = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'both', permission: 'auto' });
    await w.settle();
    return { w, parent };
  }

  it('tells the orchestrator about each child exactly once, waking it when idle', async () => {
    const { w, parent } = await orchestrated();
    // Two children may finish while the orchestrator is still on its first wake turn; then their
    // news arrives together. Either way each child is reported once.
    const news = w.agents.turns.filter((t) => t.text.startsWith('[Kestrel]')).map((t) => t.text).join('\n');
    expect(news.match(/"Child A"/g)).toHaveLength(1);
    expect(news.match(/"Child B"/g)).toHaveLength(1);
    expect(news).toMatch(/finished/);
    expect(w.agents.turns.filter((t) => t.text.startsWith('[Kestrel]'))[0]!.options.directory).toBe((await w.session(parent.id)).worktreePath);
    expect(w.runtime.overlay(parent.id)!.messages.some((m) => m.notice === 'info')).toBe(true);
  });

  it('does not tell the parent twice about the same state of a child', async () => {
    const { w, parent } = await orchestrated();
    const [kid] = await w.children(parent.id);
    const before = w.agents.turns.length;
    await w.runtime.delegation.onChildState(kid!.session.id, 'done', '');
    await w.runtime.delegation.onChildState(kid!.session.id, 'done', '');
    await w.settle();
    expect(w.agents.turns.length).toBe(before);
    // A new state change is news again.
    w.runtime.delegation.onSessionRunning(kid!.session.id);
    await w.runtime.delegation.onChildState(kid!.session.id, 'done', '');
    await w.settle();
    expect(w.agents.turns.length).toBe(before + 1);
  });

  it('does not wake the orchestrator for a turn the user started by writing in the child', async () => {
    const { w, parent } = await orchestrated();
    const [kid] = await w.children(parent.id);
    const before = w.agents.turns.filter((t) => t.text.includes('Your delegated session')).length;
    expect(before).toBeGreaterThan(0);
    await w.runtime.reply(kid!.session.id, 'one more thing, from the user');
    await w.settle();
    expect((await w.session(kid!.session.id)).state).toBe('done');
    expect(w.agents.turns.filter((t) => t.text.includes('Your delegated session')).length).toBe(before);
  });

  it('still tells the orchestrator about a delegated turn the user spoke into while it ran', async () => {
    const w = await world();
    w.agents.midTurn = 'accept';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    w.agents.script = async (turn) => {
      if (turn.text === 'one') await turn.options.tools.delegate({ tasks: [{ project: 'repoB', brief: 'Child B' }] });
      else if (turn.text.startsWith('Child')) {
        await gate; // the delegated turn is still running when the user writes in it
        writeFile(turn);
      }
    };
    const parent = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'one', permission: 'auto' });
    await until(async () => (await w.children(parent.id)).length === 1 && w.agents.starts.some((s) => s.prompt.startsWith('Child')));
    const kidId = (await w.children(parent.id))[0]!.session.id;
    await until(() => w.runtime.recordOf(kidId)?.handle?.busy() === true);
    await expect(w.runtime.reply(kidId, 'also update the changelog')).resolves.toBe('delivered');
    release();
    await w.settle();
    expect(w.agents.turns.filter((t) => t.text.includes('Your delegated session')).length).toBe(1);
  });

  it('tells an orchestrator that asked its own child for a turn once, as the asker', async () => {
    const w = await world();
    let kidId = '';
    w.agents.script = async (turn) => {
      if (turn.text === 'one') await turn.options.tools.delegate({ tasks: [{ project: 'repoB', brief: 'Child B' }] });
      else if (turn.text === 'ask the child') await turn.options.tools.askSession({ session: kidId, message: 'Rename foo' });
    };
    const parent = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'one', permission: 'auto' });
    await w.settle();
    kidId = (await w.children(parent.id))[0]!.session.id;
    const count = (re: RegExp) => w.agents.turns.filter((t) => re.test(t.text)).length;
    const delegated = count(/Your delegated session/);
    await w.runtime.reply(parent.id, 'ask the child');
    await w.settle();
    expect(w.agents.turns.some((t) => t.text.includes('Rename foo'))).toBe(true);
    expect(count(/finished the turn you asked it for/)).toBe(1);
    expect(count(/Your delegated session/)).toBe(delegated);
  });

  it('queues news for a busy orchestrator and delivers it as one turn when it finishes', async () => {
    const w = await world();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    w.agents.script = async (turn) => {
      if (turn.text === 'both') {
        await turn.options.tools.delegate({ tasks: [{ project: 'repoA', brief: 'Child A' }, { project: 'repoB', brief: 'Child B' }] });
        await gate; // the orchestrator is still busy when the children finish
      } else if (turn.text.startsWith('Child')) writeFile(turn);
    };
    const parent = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'both', permission: 'auto' });
    await until(async () => (await w.children(parent.id)).length === 2 && w.agents.starts.filter((s) => s.prompt.startsWith('Child')).length === 2);
    for (const k of await w.children(parent.id)) await until(async () => (await w.session(k.session.id)).state === 'done');
    expect(w.agents.turns.filter((t) => t.text.startsWith('[Kestrel]'))).toHaveLength(0);
    expect(w.runtime.recordOf(parent.id)!.inbox).toHaveLength(2);
    release();
    await w.settle();
    const wakes = w.agents.turns.filter((t) => t.text.startsWith('[Kestrel]'));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.text.split('\n')).toHaveLength(2);
    expect(wakes[0]!.text).toContain('Child A');
    expect(wakes[0]!.text).toContain('Child B');
  });

  it('does not wake an orchestrator the user stopped', async () => {
    const w = await world();
    w.agents.script = async (turn) => {
      if (turn.text === 'both') await turn.options.tools.delegate({ tasks: [{ project: 'repoB', brief: 'Child B' }] });
    };
    w.agents.hold = true;
    const parent = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'both', permission: 'auto' });
    await until(async () => w.agents.starts.some((s) => s.prompt === 'Child B'));
    await w.runtime.stop(parent.id);
    const [kid] = await w.children(parent.id);
    w.agents.turns.find((t) => t.text === 'Child B')!.done();
    await w.settle();
    expect((await w.session(kid!.session.id)).state).toBe('done');
    expect(w.agents.turns.filter((t) => t.text.startsWith('[Kestrel]'))).toHaveLength(0);
  });

  it('session_status shows the caller\'s own sessions only', async () => {
    const { w, parent } = await orchestrated();
    const other = await w.runtime.start({ agent: 'claude', projectId: w.b.id, prompt: 'unrelated' });
    await w.settle();
    const host = w.runtime.delegation.hostFor(parent.id);
    const all = JSON.parse((await host.sessionStatus({})).text) as { title: string; state: string; filesChanged: number | null }[];
    expect(all.map((r) => r.title).sort()).toEqual(['Child A', 'Child B']);
    expect(all.every((r) => r.state === 'done' && r.filesChanged === 1)).toBe(true);
    const refused = await host.sessionStatus({ id: other.id });
    expect(refused).toMatchObject({ isError: true, text: expect.stringMatching(/not one of your sessions/) });
  });
});

describe('asking a session that already exists', () => {
  it('sends the work as that session’s next turn after approval, and tells the asker when it ends', async () => {
    const w = await world();
    const target = await w.runtime.start({ agent: 'claude', projectId: w.b.id, prompt: 'target work' });
    await w.settle();
    w.agents.script = async (turn) => {
      if (turn.text === 'ask them') await w.call(turn, 'ask', () => turn.options.tools.askSession({ session: target.id, message: 'Rename foo to bar in src/a.ts' }));
    };
    const asker = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'ask them', permission: 'edits' });
    await until(() => w.card(asker.id) !== undefined, 'the approval card');
    expect(w.card(asker.id)).toMatchObject({ tool: 'ask_session', detail: 'Rename foo to bar in src/a.ts' });
    await w.answer(asker.id, 'allow');
    await w.settle();
    // The target got it as a turn of its own, saying who asked and that only it changes its worktree.
    const asked = w.agents.turns.find((t) => t.text.includes('Rename foo to bar'))!;
    expect(asked.text).toMatch(/^\[Kestrel\] The session ".+" \(.+\) asks you to do this in your worktree/);
    expect(asked.options.directory).toBe((await w.session(target.id)).worktreePath);
    expect(w.toolText.get('ask')).toMatch(/^Sent to ".+"/);
    // When that turn ended the asker was told, once.
    const news = w.agents.turns.filter((t) => t.text.includes('finished the turn you asked it for'));
    expect(news).toHaveLength(1);
    expect(news[0]!.options.directory).toBe((await w.session(asker.id)).worktreePath);
  });

  it('tells the asker the whole report, and refuses a fourth ask until the user writes to the asker again', async () => {
    const w = await world();
    const long = `Report: ${'x'.repeat(1500)} END`;
    const target = await w.runtime.start({ agent: 'claude', projectId: w.b.id, prompt: 'target work' });
    await w.settle();
    const answers: string[] = [];
    w.agents.script = async (turn) => {
      if (turn.text.includes('asks you to do this')) turn.emit({ type: 'text', text: long } as never);
      if (turn.text === 'ask four times' || turn.text === 'ask once more') {
        const times = turn.text === 'ask four times' ? 4 : 1;
        for (let i = 0; i < times; i++) answers.push((await turn.options.tools.askSession({ session: target.id, message: `step ${i}` })).text);
      }
    };
    const asker = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'ask four times', permission: 'auto' });
    await w.settle();
    expect(answers.slice(0, 3).every((a) => a.startsWith('Sent to'))).toBe(true);
    expect(answers[3]).toMatch(/You have asked ".+" 3 times since the user last wrote to you, which is the limit\. Do not ask it again/);
    // The user writes to the asker: it may ask again.
    await w.runtime.reply(asker.id, 'ask once more');
    await w.settle();
    expect(answers[4]).toMatch(/^Sent to/);
  });

  it('reports a long last message whole, and says so when it is cut', () => {
    expect(reportOf('short')).toBe('short');
    const whole = 'y'.repeat(REPORT_MAX);
    expect(reportOf(whole)).toBe(whole);
    const cut = reportOf(`${whole}z`);
    expect(cut.startsWith(whole)).toBe(true);
    expect(cut).toMatch(/Cut here at 6000 characters.*do not ask it to repeat itself/);
  });

  it('refuses itself, a session that is not there, an empty message, and sends nothing when declined', async () => {
    const w = await world();
    const answers: string[] = [];
    w.agents.script = async (turn) => {
      if (turn.text !== 'try') return;
      const self = (await w.workspace.state()).sessions[0]!.id;
      for (const args of [{ session: self, message: 'x' }, { session: 'nope', message: 'x' }, { session: self, message: '  ' }]) answers.push((await turn.options.tools.askSession(args)).text);
    };
    await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'try', permission: 'auto' });
    await w.settle();
    expect(answers[0]).toMatch(/That is this session/);
    expect(answers[1]).toMatch(/No such session: nope/);
    expect(answers[2]).toMatch(/message is empty/);
    expect(w.agents.turns.filter((t) => t.text.startsWith('[Kestrel] The session'))).toHaveLength(0);
  });
});

describe('stopping a workstream', () => {
  it('stops every running session it points at', async () => {
    const w = await world();
    w.agents.hold = true;
    w.agents.script = async (turn) => {
      if (turn.text === 'both') await turn.options.tools.delegate({ tasks: [{ project: 'repoA', brief: 'Child A' }, { project: 'repoB', brief: 'Child B' }] });
    };
    const parent = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'both', permission: 'auto' });
    await until(async () => w.agents.starts.filter((s) => s.prompt.startsWith('Child')).length === 2);
    const workstream = (await w.workspace.state()).workstreams[0]!.id;
    expect(await w.runtime.delegation.stopWorkstream(workstream)).toBe(3);
    await expect(w.runtime.delegation.stopWorkstream('missing')).rejects.toThrow(/No such workstream/);
    await w.settle();
    const states = (await w.workspace.state()).sessions.map((s) => s.note);
    expect(states).toEqual(['Stopped', 'Stopped', 'Stopped']);
  });
});

describe('the standing instruction and the connected check', () => {
  it('names every tool exactly and tells a no-project session that edits outside its folder follow its mode', async () => {
    const w = await world();
    await w.runtime.start({ agent: 'claude', projectId: null, prompt: 'x' });
    await w.settle();
    const text = w.agents.starts[0]!.options.instruction;
    for (const t of ['list_projects', 'add_project', 'handoff', 'delegate', 'spawn', 'session_status']) expect(text).toContain(`mcp__kestrel__${t}`);
    expect(text).toMatch(/Any git repository on this computer can become a project/);
    // Which one to use goes by who carries on, not by how many projects: asked to delegate, an agent delegates, even to one project.
    expect(text).toMatch(/mcp__kestrel__delegate`\(tasks, name\?, objective\?\): work for ONE OR MORE sessions/);
    expect(text).toMatch(/whenever the user asks you to delegate, even to a single project/);
    expect(text).toMatch(/mcp__kestrel__handoff`\(project, summary\): the whole task MOVES to another project/);
    expect(text).toMatch(/you will not hear back/);
    // Where a change is made: outside every project, the session edits it; inside another project, it delegates.
    expect(text).toMatch(/a file that is in NO registered project .* you edit yourself, from here/);
    expect(text).toMatch(/A file inside ANOTHER registered project .* is not edited from here: call `mcp__kestrel__delegate`/);
    expect(text).toMatch(/you tell the user the outcome here, where they asked/);
    expect(text).toMatch(/has no project\. You are in a scratch folder/);
    expect(text).toMatch(/An edit to a path outside your folder follows this session's permission mode/);
    expect(text).not.toMatch(/registered project is refused/);
    expect(text).toContain('repoA');
    expect(text).toContain('repoB');
  });

  it('records which Kestrel tools are missing so the header can name them', async () => {
    const w = await world();
    const adapter = w.agents.adapter();
    const runtime = new SessionRuntime(w.workspace, { claude: { ...adapter, start: (o, p, emit) => adapter.start(o, p, (e) => emit(e.type === 'started' ? { ...e, kestrelTools: 'missing', missing: ['spawn'] } : e)) } }, w.data);
    const s = await runtime.start({ agent: 'claude', projectId: null, prompt: 'x' });
    await w.settle();
    const detail = (await w.workspace.detail(s.id))!;
    expect(detail).toMatchObject({ kestrelTools: 'missing', kestrelMissing: ['spawn'] });
  });
});

describe('moving a session to another project by hand', () => {
  it('asks the agent for a summary, then starts the same linked handoff', async () => {
    const w = await world();
    w.agents.script = async (turn) => {
      if (turn.text.startsWith('Matt wants to move')) turn.emit({ type: 'message', id: 'm1', text: 'Goal: fix B. Done: nothing. Left: everything.', delta: '', done: true });
    };
    const s = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'investigate' });
    await w.settle();
    const summary = await w.runtime.delegation.draftSummary(s.id, 'repoB');
    expect(summary).toBe('Goal: fix B. Done: nothing. Left: everything.');
    const child = await w.runtime.delegation.manualMove(s.id, w.b.id, summary!);
    await w.settle();
    expect(w.agents.starts.at(-1)!.prompt).toBe(summary);
    const [link] = (await w.workspace.state()).links;
    expect(link).toMatchObject({ parentId: s.id, childId: child.id, kind: 'handoff' });
    expect(await w.session(s.id)).toMatchObject({ state: 'done', note: 'Handed off' });
  });

  it('refuses the project the session is already in, an empty summary, and a busy session', async () => {
    const w = await world();
    w.agents.hold = true;
    const s = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'x' });
    await w.runtime.idle(s.id);
    await w.agents.settled();
    await expect(w.runtime.delegation.manualMove(s.id, w.b.id, 'x')).rejects.toThrow(/still working/);
    w.agents.hold = false;
    await w.runtime.stop(s.id);
    await w.settle();
    await expect(w.runtime.delegation.manualMove(s.id, w.a.id, 'x')).rejects.toThrow(/already in repoA/);
    await expect(w.runtime.delegation.manualMove(s.id, w.b.id, '  ')).rejects.toThrow(/summary/);
  });

  it('lets Matt write the summary when the session has no agent behind it', async () => {
    const w = await world();
    const sample = await w.workspace.addSession({ title: 'Sample', agent: 'claude', startedIn: w.a.id, state: 'done' });
    expect(await w.runtime.delegation.draftSummary(sample.id, 'repoB')).toBeNull();
  });
});

describe('a tree in flight when the server restarts', () => {
  it('marks every session interrupted, keeps the links and the workstream, and resumes the orchestrator', async () => {
    const w = await world();
    w.agents.hold = true;
    w.agents.script = async (turn) => {
      if (turn.text === 'both') await turn.options.tools.delegate({ tasks: [{ project: 'repoA', brief: 'Child A' }, { project: 'repoB', brief: 'Child B' }] });
    };
    const parent = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'both', permission: 'auto' });
    await until(async () => w.agents.starts.filter((s) => s.prompt.startsWith('Child')).length === 2);
    await w.settle();
    await w.runtime.shutdown();

    const agents2 = new FakeAgents();
    const ws2 = new Workspace(w.db);
    const rt2 = new SessionRuntime(ws2, { claude: agents2.adapter() }, w.data);
    expect(await rt2.recoverAfterRestart()).toBe(3);
    const state = await ws2.state();
    expect(state.sessions.map((s) => s.state)).toEqual(['interrupted', 'interrupted', 'interrupted']);
    expect(state.links).toHaveLength(2);
    expect(state.workstreams.map((x) => x.sessionIds.length)).toEqual([3]);
    await rt2.reply(parent.id, 'carry on');
    await agents2.settled();
    expect(agents2.resumes).toHaveLength(1);
    expect(agents2.resumes[0]!.options.tools).toBeDefined();
  });
});

describe('an archived workstream', () => {
  it('comes back when the user sends a new message in one of its sessions, and the session says so; news from an agent leaves it archived', async () => {
    const w = await world();
    w.agents.script = async (turn) => {
      if (turn.text === 'split') await turn.options.tools.delegate({ tasks: [{ project: 'repoB', brief: 'Child B' }] });
    };
    const parent = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'split', permission: 'auto' });
    await w.settle();
    const workstream = (await w.workspace.state()).workstreams[0]!;
    await w.workspace.archiveWorkstream(workstream.id);
    // A message from another session (not typed by the user) does not restore it.
    await w.runtime.reply(parent.id, 'news from a worker', {}, { fromAgent: true });
    await w.settle();
    expect((await w.workspace.state()).archivedWorkstreams.map((x) => x.id)).toEqual([workstream.id]);
    await w.runtime.reply(parent.id, 'one more thing');
    await w.settle();
    const state = await w.workspace.state();
    expect(state.archivedWorkstreams).toEqual([]);
    expect(state.workstreams.map((x) => x.id)).toEqual([workstream.id]);
    const notices = w.runtime.overlay(parent.id)!.messages.filter((m) => m.text === 'Workstream restored to active work.');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.notice).toBe('info');
  });
});

describe('where a started session shows in the conversation', () => {
  it('marks each session in the caller\'s conversation where it was started', async () => {
    const w = await world();
    w.agents.script = async (turn) => {
      if (turn.text === 'both') {
        await turn.options.tools.delegate({ tasks: [{ project: 'repoB', brief: 'Child B' }] });
        await turn.options.tools.spawn({ project: 'repoA', brief: 'Unrelated' });
      }
    };
    const parent = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'both', permission: 'auto' });
    await w.settle();
    const messages = w.runtime.overlay(parent.id)!.messages;
    const started = messages.flatMap((m) => (m.started ? [m.started] : []));
    const state = await w.workspace.state();
    const delegated = state.links.find((l) => l.parentId === parent.id)!.childId;
    const spawned = state.sessions.find((s) => s.id !== parent.id && s.id !== delegated)!.id;
    expect(started).toEqual([{ sessionId: delegated, kind: 'delegate' }, { sessionId: spawned, kind: 'spawn' }]);
    // In the conversation, after the message that asked for them.
    expect(messages.findIndex((m) => m.started?.sessionId === delegated)).toBeGreaterThan(messages.findIndex((m) => m.author === 'you'));
  });
});

describe('what a restart must not lose', () => {
  it('a spawned session is still held to its worktree when it resumes', async () => {
    const w = await world();
    w.agents.script = async (turn) => {
      if (turn.text === 'spawn one') await turn.options.tools.spawn({ project: 'repoB', brief: 'Unrelated task' });
    };
    const parent = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'spawn one', permission: 'auto' });
    await until(async () => w.agents.starts.some((s) => s.prompt === 'Unrelated task'));
    await w.settle();
    const spawned = (await w.workspace.state()).sessions.find((s) => s.id !== parent.id)!;
    // No link says another session started it: only its stored record does.
    expect((await w.workspace.state()).links).toHaveLength(0);
    await w.runtime.shutdown();

    const agents2 = new FakeAgents();
    const rt2 = new SessionRuntime(new Workspace(w.db), { claude: agents2.adapter() }, w.data);
    await rt2.recoverAfterRestart();
    await rt2.reply(spawned.id, 'one more thing');
    await agents2.settled();
    expect(agents2.resumes).toHaveLength(1);
    expect(agents2.resumes[0]!.options.confineShell).toBe(true);
  });

  it('"Allow all outside the sandbox", once chosen in a session, still holds when it resumes', async () => {
    const w = await world();
    w.agents.script = async (turn) => {
      if (turn.text === 'go') turn.emit({ type: 'outside-allowed' });
    };
    const session = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'go', permission: 'auto' });
    await w.settle();
    await w.runtime.shutdown();
    expect((await w.workspace.storedDetail(session.id))?.outsideAllowed).toBe(true);

    const agents2 = new FakeAgents();
    const rt2 = new SessionRuntime(new Workspace(w.db), { claude: agents2.adapter() }, w.data);
    await rt2.recoverAfterRestart();
    await rt2.reply(session.id, 'carry on');
    await agents2.settled();
    expect(agents2.resumes[0]!.options.outsideAllowed).toBe(true);
  });

  it('a session that asked another for work hears that the turn was cut off', async () => {
    const w = await world();
    const target = await w.runtime.start({ agent: 'claude', projectId: w.b.id, prompt: 'start', permission: 'edits' });
    await w.settle();
    w.agents.hold = true;
    w.agents.script = async (turn) => {
      if (turn.text === 'ask them') await turn.options.tools.askSession({ session: target.id, message: 'Rename foo to bar' });
    };
    const asker = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'ask them', permission: 'auto' });
    await until(() => w.agents.turns.some((t) => t.text.includes('Rename foo to bar')), 'the asked turn');
    await w.runtime.shutdown();
    expect((await w.workspace.storedDetail(target.id))?.askers).toEqual([asker.id]);

    const ws2 = new Workspace(w.db);
    const rt2 = new SessionRuntime(ws2, { claude: new FakeAgents().adapter() }, w.data);
    await rt2.recoverAfterRestart();
    expect((await ws2.storedDetail(asker.id))?.inbox?.join('\n')).toMatch(/that you asked was cut off when Kestrel restarted/);
    // Told once: nobody is left waiting on the target.
    expect((await ws2.storedDetail(target.id))?.askers).toEqual([]);
  });

  it('news a session has already been given is not given again after a restart', async () => {
    const w = await world();
    w.agents.script = async (turn) => {
      if (turn.text === 'one') await turn.options.tools.delegate({ tasks: [{ project: 'repoB', brief: 'Child B' }] });
    };
    const parent = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'one', permission: 'auto' });
    await until(() => w.agents.turns.some((t) => t.text.includes('Your delegated session')), 'the news turn');
    await w.settle();
    await w.runtime.shutdown();
    expect((await w.workspace.storedDetail(parent.id))?.inbox ?? []).toEqual([]);
  });
});

describe('abandoned approval', () => {
  it('a stopped caller\'s pending delegate card resolves as declined and nothing starts', async () => {
    const w = await world();
    let text = '';
    w.agents.script = async (turn) => {
      if (turn.text === 'go') text = (await turn.options.tools.delegate({ tasks: [{ project: 'repoB', brief: 'x' }] })).text;
    };
    w.agents.hold = true;
    const s = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'go' });
    await until(() => w.card(s.id) !== undefined);
    await w.runtime.stop(s.id);
    await w.agents.settled();
    expect(text).toMatch(/declined/);
    expect(await w.children(s.id)).toHaveLength(0);
    expect(existsSync(w.data)).toBe(true);
  });
});

describe('a signed commit in a child (0.0.18)', () => {
  it('a child of a repository that signs gets GnuPG read and its agent socket; its parent, not confined, gets nothing', async () => {
    const w = await world(true);
    w.agents.script = async (turn) => {
      if (turn.text === 'split') await turn.options.tools.delegate({ tasks: [{ project: 'repoB', brief: 'Child B' }] });
    };
    await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'split', permission: 'auto' });
    await w.settle();
    const [parent, child] = w.agents.starts;
    expect(parent!.options.commitSigning).toBeUndefined();
    expect(child!.options.confineShell).toBe(true);
    expect(child!.options.commitSigning).toEqual({ read: ['/Users/me/.gnupg'], sockets: ['/Users/me/.gnupg/S.gpg-agent'] });
  });

  it("a child is kept from Kestrel's credential store; the session the user started is not", async () => {
    const w = await world(false);
    w.agents.script = async (turn) => {
      if (turn.text === 'split') await turn.options.tools.delegate({ tasks: [{ project: 'repoB', brief: 'Child B' }] });
    };
    await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'split', permission: 'auto' });
    await w.settle();
    const [parent, child] = w.agents.starts;
    const secrets = child!.options.protectedFiles!;
    expect(secrets.map((f) => basename(f)).sort()).toEqual(['connect.json', 'connect.sealed', 'trackers.json', 'trackers.sealed']);
    expect(secrets.every((f) => dirname(f) === w.data)).toBe(true);
    expect(await child!.options.intercept!({ tool: 'Read', input: { file_path: join(w.data, 'trackers.json') } })).toEqual({ allow: false, message: PROTECTED_REFUSAL });
    expect(await child!.options.intercept!({ tool: 'Bash', input: { command: `cat ${join(w.data, 'connect.sealed')}` } })).toEqual({ allow: false, message: PROTECTED_REFUSAL });
    expect(await child!.options.intercept!({ tool: 'Read', input: { file_path: join(w.data, 'notes.txt') } })).toEqual({ allow: true });
    // The top-level session is not confined: it can read the file, as the user can.
    expect(parent!.options.protectedFiles).toBeUndefined();
    expect(await parent!.options.intercept!({ tool: 'Read', input: { file_path: join(w.data, 'trackers.json') } })).toEqual({ allow: true });
  });

  it('a child of a repository that does not sign gets nothing for signing, nor with the switch off', async () => {
    const w = await world(false);
    w.agents.script = async (turn) => {
      if (turn.text === 'split') await turn.options.tools.delegate({ tasks: [{ project: 'repoB', brief: 'Child B' }] });
    };
    await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'split', permission: 'auto' });
    await w.settle();
    expect(w.agents.starts[1]!.options.commitSigning).toBeUndefined();

    const off = await world(true);
    await off.runtime.commitSigning.setAllowed(false);
    off.agents.script = w.agents.script;
    await off.runtime.start({ agent: 'claude', projectId: off.a.id, prompt: 'split', permission: 'auto' });
    await off.settle();
    expect(off.agents.starts[1]!.options.commitSigning).toBeUndefined();
  });
});
