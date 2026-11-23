// A session gets to where its work belongs (shared/session-move.ts, runtime/move-project.ts,
// delegation.ts `moveToProject`, `finishTurn`): with no project it asks to move itself into one and
// keeps its conversation; in the wrong project it hands the task off and offers to archive itself.
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { standingInstruction } from './agents/instruction.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { SessionRuntime } from './runtime.ts';
import { projectWorkedIn } from './shared/session-move.ts';
import type { Project } from './model.ts';
import { FakeAgents, until } from './test-agent.ts';
import { makeRepo } from './test-repo.ts';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import { Workspace } from './workspace.ts';

vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

async function world() {
  const workspace = new Workspace(memoryPersistence());
  const claude = new FakeAgents();
  const runtime = new SessionRuntime(workspace, { claude: claude.adapter() }, realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-move-'))));
  const config = await runtime.registerProject(makeRepo(), 'configuration-management');
  const other = await runtime.registerProject(makeRepo(), 'app');
  const results: { text: string; isError?: boolean }[] = [];
  /** A session whose first turn makes one tool call; later turns just finish. */
  const start = async (projectId: string | null, call: (tools: (typeof claude.turns)[number]['options']['tools']) => Promise<{ text: string; isError?: boolean }>) => {
    claude.script = async (turn) => {
      if (turn.text === 'go') results.push(await call(turn.options.tools));
    };
    return runtime.start({ agent: 'claude', projectId, prompt: 'go' });
  };
  const card = (id: string) => runtime.overlay(id)?.messages.map((m) => m.input).find((i) => i && runtime.recordOf(id)?.kestrelRequests.has(i.id));
  const notices = (id: string) => runtime.overlay(id)?.messages.filter((m) => m.notice).map((m) => m.text) ?? [];
  const row = async (id: string) => (await workspace.state()).sessions.find((s) => s.id === id);
  return { workspace, claude, runtime, config, other, results, start, card, notices, row };
}

describe('a session with no project', () => {
  it('asks to move into the project the work is in, and on a yes carries on there with its conversation', async () => {
    const { claude, runtime, config, results, start, card, notices, row } = await world();
    const session = await start(null, (tools) => tools.moveToProject({ project: 'configuration-management', reason: 'The Home Assistant configuration lives there.' }));
    await until(() => card(session.id) !== undefined, 'the card');
    expect(card(session.id)!.title).toBe('Move this session to configuration-management?');
    expect(card(session.id)!.detail).toContain('The Home Assistant configuration lives there.');
    expect(card(session.id)!.detail).toContain('It keeps this conversation and gets a worktree in configuration-management');
    // Nothing moves until the user says so, and then not before the turn has ended.
    expect((await row(session.id))!.startedIn).toBeNull();
    await runtime.answer(session.id, card(session.id)!.id, { optionId: 'allow' });
    await until(() => claude.turns.some((t) => t.text.includes('You are now in configuration-management')), 'the session woken in the project');
    expect(results[0]!.text).toContain('The user approved. Kestrel moves this session to configuration-management as soon as this turn ends');
    const moved = (await row(session.id))!;
    expect(moved.startedIn).toBe(config.id);
    expect(moved.worktreePath && existsSync(moved.worktreePath)).toBe(true);
    expect(moved.branch).toBeTruthy();
    // The agent's own copy of the conversation, set to work in the worktree, is what it resumes.
    expect(claude.forks).toHaveLength(1);
    expect(claude.forks[0]!.to).toBe(moved.worktreePath);
    expect(claude.resumes.at(-1)).toMatchObject({ id: claude.forks[0]!.forkedId });
    expect(claude.resumes.at(-1)!.options.directory).toBe(moved.worktreePath);
    // With no project it could only read; in one it works as a new session there would.
    expect(runtime.recordOf(session.id)!.settings.permission).not.toBe('readonly');
    expect(notices(session.id).join('\n')).toContain(`Moved to configuration-management. This session keeps its conversation and now works in a worktree of its own, on branch ${moved.branch}.`);
  });

  it('stays where it is on a no, and when the conversation cannot be carried over', async () => {
    const no = await world();
    const stays = await no.start(null, (tools) => tools.moveToProject({ project: 'app' }));
    await until(() => no.card(stays.id) !== undefined, 'the card');
    await no.runtime.answer(stays.id, no.card(stays.id)!.id, { optionId: 'deny' });
    await until(() => no.results.length === 1, 'the answer');
    expect(no.results[0]!.text).toContain('The user chose not to move this session.');
    await no.runtime.idle(stays.id);
    expect((await no.row(stays.id))!.startedIn).toBeNull();
    expect(no.claude.forks).toHaveLength(0);

    const broken = await world();
    broken.claude.forkFailure = 'no such conversation';
    const session = await broken.start(null, (tools) => tools.moveToProject({ project: 'app' }));
    await until(() => broken.card(session.id) !== undefined, 'the card');
    await broken.runtime.answer(session.id, broken.card(session.id)!.id, { optionId: 'allow' });
    await until(() => broken.notices(session.id).some((n) => n.includes('could not be moved')), 'the failure said');
    expect(broken.notices(session.id).join('\n')).toContain('This session could not be moved to app: The agent could not carry the conversation over: no such conversation It is still where it was.');
    const row = (await broken.row(session.id))!;
    expect(row.startedIn).toBeNull();
    expect(row.worktreePath).toBeNull();
  });

  it('is told to ask, and a session that has a project is refused and pointed at handoff', async () => {
    const t = (name: string) => `kestrel_${name}`;
    const none = standingInstruction({ toolName: t, projects: [], workspace: { kind: 'read-only', noProject: true } });
    expect(none).toContain('call `kestrel_move_to_project` with that project, and the folder of it the work is in when it has several');
    const inProject = standingInstruction({ toolName: t, projects: [], workspace: { kind: 'worktree', branch: 'x' } });
    expect(inProject).not.toContain('do not answer as an outsider');
    expect(inProject).toContain('pass `archive_self: true`');

    const { other, results, start } = await world();
    await start(other.id, (tools) => tools.moveToProject({ project: 'configuration-management' }));
    await until(() => results.length === 1, 'the refusal');
    expect(results[0]).toMatchObject({ isError: true });
    expect(results[0]!.text).toContain('This session is already in a project. A session in a project stays there: when the task belongs in another project, call handoff (with archive_self when this session has nothing left to do).');
  });
});

describe('a session in the wrong project', () => {
  it('offers to hand the task off and archive itself, and is archived when its turn ends', async () => {
    const { workspace, claude, runtime, other, config, results, start, card } = await world();
    const session = await start(other.id, (tools) => tools.handoff({ project: 'configuration-management', summary: 'Add the porch light to Home Assistant.', archive_self: true }));
    await until(() => card(session.id) !== undefined, 'the card');
    expect(card(session.id)!.title).toBe('Hand this task to configuration-management and archive this session?');
    expect(claude.starts).toHaveLength(1);
    await runtime.answer(session.id, card(session.id)!.id, { optionId: 'allow' });
    await until(async () => (await workspace.state()).archived.sessions.some((s) => s.id === session.id), 'the session archived');
    expect(results[0]!.text).toContain('Handed off to configuration-management');
    const child = (await workspace.state()).sessions.find((s) => s.id !== session.id)!;
    expect(child.startedIn).toBe(config.id);
    expect(claude.starts[1]!.prompt).toContain('Add the porch light to Home Assistant.');
  });

  it('starts nothing and stays on a no, and a plain handoff asks nothing and archives nothing', async () => {
    const no = await world();
    const stays = await no.start(no.other.id, (tools) => tools.handoff({ project: 'configuration-management', summary: 'x', archive_self: true }));
    await until(() => no.card(stays.id) !== undefined, 'the card');
    await no.runtime.answer(stays.id, no.card(stays.id)!.id, { optionId: 'deny' });
    await until(() => no.results.length === 1, 'the answer');
    expect(no.results[0]!.text).toContain('The user chose not to hand the task off.');
    await no.runtime.idle(stays.id);
    expect(no.claude.starts).toHaveLength(1);
    expect((await no.workspace.state()).archived.sessions).toHaveLength(0);

    const plain = await world();
    const session = await plain.start(plain.other.id, (tools) => tools.handoff({ project: 'configuration-management', summary: 'x' }));
    await until(() => plain.results.length === 1, 'the handoff');
    await plain.runtime.idle(session.id);
    expect(plain.card(session.id)).toBeUndefined();
    expect((await plain.workspace.state()).archived.sessions).toHaveLength(0);
  });
});

describe('Kestrel’s own offer to move', () => {
  const folder = (id: string, path: string) => ({ id, path, isGit: true });
  const project = (id: string, ...paths: string[]): Project => ({ id, name: id, folders: paths.map((path, i) => folder(`${id}-${i}`, path)), defaultFolderId: `${id}-0` }) as unknown as Project;
  const projects = [project('config', '/code/configuration-management'), project('app', '/code/app', '/code/app/web'), project('old', '/code/app-old')];

  it('finds the one project a turn’s work was in, and the folder of it', () => {
    expect(projectWorkedIn(['Run cd /code/configuration-management/home-assistant && ls', 'Read /code/configuration-management/README.md'], projects)?.project.id).toBe('config');
    // A path inside an inner folder counts for the inner one, and a longer name is another folder.
    expect(projectWorkedIn(['cat /code/app/web/index.html', 'cat /code/app/web/app.css', 'ls /code/app'], projects)?.folder.id).toBe('app-1');
    expect(projectWorkedIn(['ls /code/app-old/src'], projects)?.project.id).toBe('old');
    // Nowhere, or in two projects: there is no one place it belongs.
    expect(projectWorkedIn(['echo hello', 'Read /tmp/notes.md'], projects)).toBeNull();
    expect(projectWorkedIn(['ls /code/app', 'ls /code/configuration-management'], projects)).toBeNull();
  });

  it('is made when a session with no project finishes a turn spent in one project, and moves it on a yes', async () => {
    const { workspace, claude, runtime, config, row } = await world();
    const path = config.folders[0]!.path;
    claude.script = (turn) => {
      if (turn.text !== 'What trackers do we have?') return;
      turn.emit({ type: 'tool', id: 't1', name: 'Bash', summary: `Run cd ${path} && grep -r device_tracker`, command: `cd ${path} && grep -r device_tracker`, status: 'started' });
      turn.emit({ type: 'tool', id: 't1', name: 'Bash', summary: `Run cd ${path} && grep -r device_tracker`, command: `cd ${path} && grep -r device_tracker`, status: 'finished' });
    };
    const session = await runtime.start({ agent: 'claude', projectId: null, prompt: 'What trackers do we have?' });
    const offer = () => runtime.overlay(session.id)?.messages.map((m) => m.suggestion).find((s) => s?.kind === 'move');
    await until(() => offer() !== undefined, 'the offer');
    expect(offer()).toMatchObject({ title: 'Move this session to configuration-management?', state: 'open' });
    expect(offer()!.reason).toContain('what it just did was all in configuration-management');
    expect(offer()!.buttons.map((b) => b.label)).toEqual(['Move it there', 'Not now']);
    // The answer was not held up: the turn is over, and nothing has moved.
    expect((await row(session.id))!.state).toBe('done');
    expect((await row(session.id))!.startedIn).toBeNull();
    const turnsBefore = claude.turns.length;
    await runtime.suggestions.answer(session.id, offer()!.id, 'move');
    await until(async () => (await row(session.id))!.startedIn === config.id, 'the session to move');
    await runtime.idle(session.id);
    // The user moved it, and nothing was asked of the agent: it is not woken to answer a notice.
    expect(claude.turns).toHaveLength(turnsBefore);
    expect((await row(session.id))!.state).toBe('done');
    // It hears where it is with the user's next message.
    await runtime.reply(session.id, 'Now fix the tracker');
    await until(() => claude.turns.length === turnsBefore + 1, 'the next turn');
    expect(claude.turns.at(-1)!.text).toContain('the user moved this session to configuration-management');
    expect(claude.turns.at(-1)!.text).toContain('needs no reply or action');
    expect(claude.turns.at(-1)!.text).toContain('Now fix the tracker');
    expect((await workspace.state()).sessions).toHaveLength(1);
  });

  it('is asked once in a session, and not for a turn that touched no project or a session that has one', async () => {
    const { claude, runtime, config, other } = await world();
    const path = config.folders[0]!.path;
    const tool = (turn: (typeof claude.turns)[number]) => {
      turn.emit({ type: 'tool', id: `t${turn.n}`, name: 'Read', summary: `Read ${path}/README.md`, status: 'started' });
      turn.emit({ type: 'tool', id: `t${turn.n}`, name: 'Read', summary: `Read ${path}/README.md`, status: 'finished' });
    };
    const offers = (id: string) => runtime.overlay(id)?.messages.filter((m) => m.suggestion?.kind === 'move') ?? [];
    claude.script = (turn) => (turn.text.startsWith('read') ? tool(turn) : undefined);
    const quiet = await runtime.start({ agent: 'claude', projectId: null, prompt: 'hello' });
    await runtime.idle(quiet.id);
    expect(offers(quiet.id)).toHaveLength(0);
    const inProject = await runtime.start({ agent: 'claude', projectId: other.id, prompt: 'read it' });
    await runtime.idle(inProject.id);
    expect(offers(inProject.id)).toHaveLength(0);

    const session = await runtime.start({ agent: 'claude', projectId: null, prompt: 'read it' });
    await until(() => offers(session.id).length === 1, 'the offer');
    await runtime.suggestions.answer(session.id, offers(session.id)[0]!.suggestion!.id, 'skip');
    await runtime.reply(session.id, 'read it again');
    await runtime.idle(session.id);
    expect(offers(session.id)).toHaveLength(1);
  });
});

