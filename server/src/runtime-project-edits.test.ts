// "Keep each project's edits in its own session": what every session's agent is answered before a
// file edit runs. The rule is shared/project-edits.ts; this checks the runtime asks it with real
// folders, hands it to the agent, and obeys the setting.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { projectEditsRoute } from './project-edits/api.ts';
import { createProject } from './project-store.ts';
import { SessionRuntime } from './runtime.ts';
import { FakeAgents, until } from './test-agent.ts';
import { makeRepo } from './test-repo.ts';
import { Workspace } from './workspace.ts';

// Builds real git repositories: room under a loaded machine (test-timeouts.ts).
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

async function started() {
  const workspace = new Workspace(memoryPersistence());
  const agents = new FakeAgents();
  const runtime = new SessionRuntime(workspace, { claude: agents.adapter() }, realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-edits-'))));
  const [vireoRepo, configRepo] = [makeRepo(), makeRepo()];
  const vireo = await createProject(workspace, { name: 'Vireo', folders: [vireoRepo] });
  await createProject(workspace, { name: 'Configuration Management', folders: [configRepo] });
  const session = await runtime.start({ agent: 'claude', projectId: vireo.id, prompt: 'work' });
  await until(async () => (await workspace.state()).sessions.find((s) => s.id === session.id)!.worktreePath !== null, 'the worktree');
  await agents.settled();
  await runtime.idle(session.id);
  const options = agents.starts[0]!.options;
  const ask = (tool: string, input: Record<string, unknown>) => options.intercept!({ tool, input });
  return { runtime, workspace, vireoRepo, configRepo, options, ask };
}

describe('an edit to a file in another project', () => {
  it('is refused with the reason and what to do instead; the session’s own project and files in no project are not', async () => {
    const w = await started();
    const refused = await w.ask('Write', { file_path: join(w.configRepo, 'k8s', 'vireo.yaml') });
    expect(refused).toMatchObject({ allow: false });
    expect((refused as { message: string }).message).toMatch(/is in the Kestrel project "Configuration Management".*Call mcp__kestrel__delegate with a brief/);
    expect(await w.ask('Edit', { file_path: join(w.configRepo, 'README.md') })).toMatchObject({ allow: false });
    expect(await w.ask('NotebookEdit', { notebook_path: join(w.configRepo, 'n.ipynb') })).toMatchObject({ allow: false });
    // Its own worktree, its own project's main checkout, a file in no project, and a path given relative to its folder.
    expect(await w.ask('Write', { file_path: join(w.options.directory, 'a.txt') })).toEqual({ allow: true });
    expect(await w.ask('Edit', { file_path: join(w.vireoRepo, 'README.md') })).toEqual({ allow: true });
    expect(await w.ask('Write', { file_path: join(tmpdir(), 'kestrel-no-project.txt') })).toEqual({ allow: true });
    expect(await w.ask('Write', { file_path: 'notes.md' })).toEqual({ allow: true });
    // Anything that is not a file edit is not this rule's business.
    expect(await w.ask('Bash', { command: `echo x > ${join(w.configRepo, 'x')}` })).toEqual({ allow: true });
    expect(await w.ask('Read', { file_path: join(w.configRepo, 'README.md') })).toEqual({ allow: true });
  });

  it('is refused for a file in another session’s worktree, naming the session and the tool that asks it', async () => {
    const w = await started();
    const other = await w.runtime.start({ agent: 'claude', projectId: null, prompt: 'x' });
    const state = async () => (await w.workspace.state()).sessions;
    const mine = (await state()).find((s) => s.worktreePath === w.options.directory)!;
    // Give the other session a worktree of its own: a real folder, as Kestrel would make.
    const theirs = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-their-worktree-')));
    await w.workspace.attachWorktree(other.id, { path: theirs, branch: 'kestrel/theirs' });
    const refused = await w.ask('Edit', { file_path: join(theirs, 'src', 'a.ts') });
    expect(refused).toMatchObject({ allow: false });
    expect((refused as { message: string }).message).toMatch(new RegExp(`is in the worktree of the session "[^"]+" \\(${other.id}\\).*Call mcp__kestrel__ask_session with session "${other.id}"`));
    // Its own worktree is its own.
    expect(await w.ask('Edit', { file_path: join(mine.worktreePath!, 'a.ts') })).toEqual({ allow: true });
    await w.runtime.projectEdits.setKeepInProject(false);
    expect(await w.ask('Edit', { file_path: join(theirs, 'src', 'a.ts') })).toEqual({ allow: true });
  });

  it('goes ahead once the user switches the rule off, and is refused again when it is back on', async () => {
    const w = await started();
    const target = { file_path: join(w.configRepo, 'README.md') };
    expect(await w.runtime.projectEdits.prefs()).toEqual({ keepInProject: true });
    await w.runtime.projectEdits.setKeepInProject(false);
    expect(await w.ask('Edit', target)).toEqual({ allow: true });
    await w.runtime.projectEdits.setKeepInProject(true);
    expect(await w.ask('Edit', target)).toMatchObject({ allow: false });
  });

  it('is read and changed over HTTP, and a value that is not true or false is refused', async () => {
    const w = await started();
    const route = (method: string, body: Record<string, unknown> = {}) => projectEditsRoute(['api', 'project-edits'], method, async () => body, w.runtime.projectEdits);
    expect(await route('GET')).toEqual({ status: 200, body: { keepInProject: true } });
    expect(await route('PATCH', { keepInProject: false })).toEqual({ status: 200, body: { keepInProject: false } });
    expect(await route('GET')).toEqual({ status: 200, body: { keepInProject: false } });
    expect(await route('PATCH', { keepInProject: 'yes' })).toMatchObject({ status: 400 });
    expect(await projectEditsRoute(['api', 'other'], 'GET', async () => ({}), w.runtime.projectEdits)).toBeNull();
  });
});
