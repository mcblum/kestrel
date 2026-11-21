// Sessions in projects with no directory, and in projects with several: where they work, what they
// may read, what they are told, and handing work to another directory of the same project.
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import { confinementDenial, writeOutside } from './agents/claude/confine.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { createProject } from './project-store.ts';
import { terminalFolder } from './scope-folder.ts';
import { SessionRuntime } from './runtime.ts';
import { FakeAgents, until } from './test-agent.ts';
import { makeRepo } from './test-repo.ts';
import { worktreeRepo } from './worktree-repo.ts';
import { Workspace } from './workspace.ts';

// Builds real git repositories: room under a loaded machine (test-timeouts.ts).
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

async function world() {
  const workspace = new Workspace(memoryPersistence());
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-folders-')));
  const agents = new FakeAgents();
  const runtime = new SessionRuntime(workspace, { claude: agents.adapter() }, data);
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await agents.settled();
      for (const s of (await workspace.state()).sessions) await runtime.idle(s.id);
    }
  };
  const view = async (id: string) => (await workspace.state()).sessions.find((s) => s.id === id)!;
  return { workspace, data, agents, runtime, settle, view };
}

describe('a project with no directory', () => {
  it('starts a session like one with no project: scratch folder, no worktree, no branch, but filed under the project', async () => {
    const w = await world();
    const ideas = await createProject(w.workspace, { name: 'Ideas' });
    const session = await w.runtime.start({ agent: 'claude', projectId: ideas.id, prompt: 'think about it' });
    await w.settle();
    const start = w.agents.starts[0]!;
    expect(start.options.directory).toBe(join(w.data, 'scratch'));
    expect(start.options.instruction).toMatch(/This session has no project. You are in a scratch folder/);
    expect(await w.view(session.id)).toMatchObject({ startedIn: ideas.id, startedFolderId: null, folderId: null, worktreePath: null, branch: null, filing: { projectId: ideas.id, status: 'started' } });
    expect(await w.runtime.folderOf(`project:${ideas.id}`)).toBeNull();
    const projects = (await w.workspace.state()).projects;
    expect(await terminalFolder(projects, `project:${ideas.id}`, (k) => w.runtime.folderOf(k))).toBe(homedir());
  });
});

describe('a project with several directories', () => {
  it('starts in the default directory unless another is chosen, and cuts the worktree in the chosen one', async () => {
    const w = await world();
    const web = makeRepo();
    const api = makeRepo();
    const shop = await createProject(w.workspace, { name: 'Shop', folders: [web, api] });
    const [webDir, apiDir] = shop.folders;

    const first = await w.runtime.start({ agent: 'claude', projectId: shop.id, prompt: 'default one' });
    const second = await w.runtime.start({ agent: 'claude', projectId: shop.id, folderId: apiDir!.id, prompt: 'the api one' });
    await until(async () => (await w.view(second.id)).worktreePath !== null && (await w.view(first.id)).worktreePath !== null, 'both worktrees');
    await w.settle();

    const one = await w.view(first.id);
    const two = await w.view(second.id);
    expect(one).toMatchObject({ startedFolderId: webDir!.id, folderId: webDir!.id });
    expect(two).toMatchObject({ startedFolderId: apiDir!.id, folderId: apiDir!.id, branch: expect.stringMatching(/^kestrel\//) });
    expect(worktreeRepo(one.worktreePath!)).toBe(web);
    expect(worktreeRepo(two.worktreePath!)).toBe(api);
    expect(await w.runtime.directoryOf(second.id)).toBe(two.worktreePath);
  });

  it('refuses a directory that is not in the project', async () => {
    const w = await world();
    const shop = await createProject(w.workspace, { name: 'Shop', folders: [makeRepo()] });
    await expect(w.runtime.start({ agent: 'claude', projectId: shop.id, folderId: 'nope', prompt: 'x' })).rejects.toThrow('Shop has no such folder.');
  });

  it('lets the session read the other directories, edit them under its mode, and tells it about handoff and delegate', async () => {
    const w = await world();
    const web = makeRepo();
    const docs = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-docs-')));
    const shop = await createProject(w.workspace, { name: 'Shop', folders: [web, docs] });
    const session = await w.runtime.start({ agent: 'claude', projectId: shop.id, prompt: 'work' });
    await until(() => w.agents.starts.length === 1, 'the agent started');
    await w.settle();
    const o = w.agents.starts[0]!.options;
    // The other directory, and the session's own attachments folder (attachments/store.ts).
    expect(o.readableDirectories).toEqual([docs, w.runtime.attachments.sessionDir(session.id)]);
    expect(o.instruction).toContain(`Shop has other directories besides the one you work in: ${docs.split('/').at(-1)} (${docs})`);
    expect(o.instruction).toMatch(/with project "Shop" and folder set to that directory's name/);
    expect(o.instruction).toContain('- Shop, several directories:');
    expect(o.instruction).toContain(`  - ${web} (the default)`);
    const directory = (await w.view(session.id)).worktreePath!;
    const confinement = { directory, readOnly: false, readable: o.readableDirectories ?? [] };
    // Editing the other directory is outside the session's folder: not refused, its mode decides.
    expect(confinementDenial('Edit', { file_path: join(docs, 'readme.md') }, confinement)).toBeNull();
    expect(writeOutside('Edit', { file_path: join(docs, 'readme.md') }, directory)).not.toBeNull();
    expect(writeOutside('Edit', { file_path: join(directory, 'a.txt') }, directory)).toBeNull();
    expect(confinementDenial('Read', { file_path: join(docs, 'readme.md') }, { ...confinement, readOnly: true })).toBeNull();
  });

  it('hands off to another directory of the same project, and refuses a handoff to its own', async () => {
    const w = await world();
    const web = makeRepo();
    const api = makeRepo();
    const shop = await createProject(w.workspace, { name: 'Shop', folders: [web, api] });
    const said: string[] = [];
    w.agents.script = async (turn) => {
      if (turn.text !== 'go') return;
      said.push((await turn.options.tools.handoff({ project: 'Shop', summary: 'Stay here' })).text);
      said.push((await turn.options.tools.handoff({ project: 'Shop', folder: api.split('/').at(-1), summary: 'Fix the api' })).text);
    };
    const parent = await w.runtime.start({ agent: 'claude', projectId: shop.id, prompt: 'go' });
    await until(() => said.length === 2, 'both handoffs answered');
    await w.settle();
    expect(said[0]).toMatch(/You are already working in Shop · /);
    expect(said[1]).toMatch(/^Handed off to Shop · /);
    const child = (await w.workspace.state()).sessions.find((s) => s.id !== parent.id)!;
    expect(child).toMatchObject({ startedIn: shop.id, startedFolderId: shop.folders[1]!.id });
    await until(async () => (await w.view(child.id)).worktreePath !== null, 'the child worktree');
    expect(worktreeRepo((await w.view(child.id)).worktreePath!)).toBe(api);
  });

  it('lists every directory to list_projects, the default first, and still gives the default path', async () => {
    const w = await world();
    const a = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-a-')));
    const b = join(a, '..', `${a.split('/').at(-1)}-b`);
    mkdirSync(b);
    await createProject(w.workspace, { name: 'Two', folders: [a, realpathSync(b)] });
    await createProject(w.workspace, { name: 'None' });
    const listed = await w.runtime.delegation.hostFor('caller').listProjects();
    expect(listed).toEqual([
      { name: 'Two', path: a, isGit: false, folders: [{ name: a.split('/').at(-1), path: a, isGit: false }, { name: `${a.split('/').at(-1)}-b`, path: realpathSync(b), isGit: false }] },
      { name: 'None', path: null, isGit: false, folders: [] },
    ]);
  });
});
