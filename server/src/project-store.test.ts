// The rules for projects and their directories, checked on the server (project-store.ts), and the
// older "ensure a project for this path" kept working beside them.
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { addFolder, createProject, FieldRefused, liveWorktreesIn, removeFolder, reorderFolders } from './project-store.ts';
import { ensureProject, registerProject } from './runtime/projects.ts';
import { makeRepo } from './test-repo.ts';
import { Workspace } from './workspace.ts';

// Builds real git repositories: room under a loaded machine (test-timeouts.ts).
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

const plainDir = (name = 'plain') => {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-dirs-'))), name);
  mkdirSync(dir);
  return dir;
};
const fresh = () => new Workspace(memoryPersistence());

describe('creating a project', () => {
  it('needs only a name: a project may have no directory', async () => {
    const ws = fresh();
    const project = await createProject(ws, { name: '  Ideas  ' });
    expect(project).toMatchObject({ name: 'Ideas', folders: [] });
    expect((await ws.state()).projects).toEqual([project]);
  });

  it('keeps the directories in the order given, each checked: git or plain', async () => {
    const ws = fresh();
    const repo = makeRepo();
    const notes = plainDir('notes');
    const project = await createProject(ws, { name: 'Shop', folders: [repo, notes] });
    expect(project.folders.map((f) => [f.path, f.isGit])).toEqual([[repo, true], [notes, false]]);
  });

  it('refuses an empty name, and a name another project has in any case', async () => {
    const ws = fresh();
    await createProject(ws, { name: 'Shop' });
    await expect(createProject(ws, { name: '   ' })).rejects.toThrow('A project needs a name.');
    const taken = createProject(ws, { name: 'SHOP' });
    await expect(taken).rejects.toThrow('There is already a project called Shop.');
    await expect(taken).rejects.toMatchObject({ field: 'name' });
  });

  it('refuses a path that is not a directory, naming that path', async () => {
    const ws = fresh();
    const missing = join(tmpdir(), 'kestrel-no-such-dir-xyz');
    await expect(createProject(ws, { name: 'X', folders: [missing] })).rejects.toMatchObject({ message: `${missing} is not a folder that exists.`, field: missing });
    expect((await ws.state()).projects).toEqual([]);
  });

  it('takes a path written from the home folder (~/…)', async () => {
    const ws = fresh();
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-home-')));
    mkdirSync(join(home, 'site'));
    const before = process.env.HOME;
    process.env.HOME = home; // os.homedir() reads it
    try {
      const project = await createProject(ws, { name: 'Tilde', folders: ['~/site'] });
      expect(project.folders.map((f) => f.path)).toEqual([join(home, 'site')]);
    } finally {
      process.env.HOME = before;
    }
  });

  it('refuses the same directory twice, also by another path to it', async () => {
    const ws = fresh();
    const dir = plainDir();
    const link = join(dir, '..', 'link');
    symlinkSync(dir, link);
    await expect(createProject(ws, { name: 'X', folders: [dir, link] })).rejects.toThrow(`${dir} is listed twice.`);
  });

  it('refuses a directory another project already has', async () => {
    const ws = fresh();
    const dir = plainDir();
    await createProject(ws, { name: 'First', folders: [dir] });
    await expect(createProject(ws, { name: 'Second', folders: [dir] })).rejects.toThrow(`${dir} is already in the project First.`);
  });

  it('refuses a folder inside a repository, pointing at its top level', async () => {
    const ws = fresh();
    const repo = makeRepo();
    const sub = join(repo, 'src');
    mkdirSync(sub);
    await expect(createProject(ws, { name: 'X', folders: [sub] })).rejects.toThrow(`Add its top level instead: ${repo}`);
  });
});

describe('a project’s directories later', () => {
  it('can be added to a project made with none, then reordered, then removed', async () => {
    const ws = fresh();
    const project = await createProject(ws, { name: 'Ideas' });
    const a = plainDir('a');
    const b = makeRepo();
    await addFolder(ws, project.id, a);
    const both = await addFolder(ws, project.id, b);
    expect(both.folders.map((f) => f.path)).toEqual([a, b]);
    const swapped = await reorderFolders(ws, project.id, [both.folders[1]!.id, both.folders[0]!.id]);
    expect(swapped.folders.map((f) => f.path)).toEqual([b, a]);
    const left = await removeFolder(ws, project.id, swapped.folders[0]!.id);
    expect(left.folders.map((f) => f.path)).toEqual([a]);
    const empty = await removeFolder(ws, project.id, left.folders[0]!.id);
    expect(empty.folders).toEqual([]);
  });

  it('refuses a directory already in this project, or in another', async () => {
    const ws = fresh();
    const dir = plainDir();
    const mine = await createProject(ws, { name: 'Mine', folders: [dir] });
    const other = await createProject(ws, { name: 'Other' });
    await expect(addFolder(ws, mine.id, dir)).rejects.toThrow(`${dir} is already in this project.`);
    await expect(addFolder(ws, other.id, dir)).rejects.toThrow(`${dir} is already in the project Mine.`);
  });

  it('takes a new order only when it lists each directory once', async () => {
    const ws = fresh();
    const project = await createProject(ws, { name: 'P', folders: [plainDir('a'), plainDir('b')] });
    await expect(reorderFolders(ws, project.id, [project.folders[0]!.id])).rejects.toThrow('The folders changed. Try again.');
    await expect(reorderFolders(ws, project.id, [project.folders[0]!.id, project.folders[0]!.id])).rejects.toThrow('The folders changed.');
  });

  it('refuses to remove a directory that live session worktrees were cut from, saying how many', async () => {
    const ws = fresh();
    const project = await createProject(ws, { name: 'P', folders: [plainDir('a'), plainDir('b')] });
    const [a, b] = project.folders;
    for (const id of ['s1', 's2']) {
      await ws.addSession({ id, title: id, agent: 'claude', startedIn: project.id, startedFolderId: a!.id, state: 'done' });
      await ws.attachWorktree(id, { path: `/wt/${id}`, branch: `kestrel/${id}` });
    }
    await ws.addSession({ id: 'gone', title: 'gone', agent: 'claude', startedIn: project.id, startedFolderId: a!.id, state: 'done' });
    await ws.attachWorktree('gone', { path: '/wt/gone', branch: 'kestrel/gone' });
    await ws.discardWorktree('gone');
    const refusal = removeFolder(ws, project.id, a!.id);
    await expect(refusal).rejects.toThrow('2 sessions still have their worktrees in a. Delete them first, or keep the folder.');
    await expect(refusal).rejects.toBeInstanceOf(FieldRefused);
    expect((await removeFolder(ws, project.id, b!.id)).folders.map((f) => f.id)).toEqual([a!.id]);
  });

  it('counts a session from before (no directory recorded) by the repository its worktree came from', () => {
    const project = { id: 'p', name: 'P', folders: [{ id: 'a', path: '/c/a', isGit: true }, { id: 'b', path: '/c/b', isGit: true }] };
    const old = { id: 's', title: 's', agent: 'claude' as const, state: 'done' as const, note: '', startedIn: 'p', startedFolderId: null, landedIn: null, worktreePath: '/wt/s', branch: 'k', worktreeDiscarded: false, groupId: null, createdAt: 1, updatedAt: 1 };
    expect(liveWorktreesIn(project, 'b', [old], () => '/c/b')).toHaveLength(1);
    expect(liveWorktreesIn(project, 'a', [old], () => '/c/b')).toHaveLength(0);
  });
});

describe('renaming', () => {
  it('keeps names unique in any case', async () => {
    const ws = fresh();
    await createProject(ws, { name: 'Shop' });
    const other = await createProject(ws, { name: 'Other' });
    await expect(ws.renameProject(other.id, 'shop')).rejects.toThrow('There is already a project called Shop.');
    await ws.renameProject(other.id, 'Other Two');
    await ws.renameProject(other.id, 'other two');
    expect((await ws.state()).projects.map((p) => p.name)).toEqual(['Shop', 'other two']);
  });
});

describe('ensuring a project for a path (the picker and the agent tools)', () => {
  it('creates a one-directory project named after it, then returns the same project again', async () => {
    const ws = fresh();
    const repo = makeRepo();
    const first = await ensureProject(ws, repo);
    expect(first).toMatchObject({ created: true, project: { name: basename(repo), folders: [{ path: repo, isGit: true }] } });
    expect(await ensureProject(ws, repo)).toEqual({ created: false, project: first.project });
  });

  it('returns the project that holds the directory, even as its second', async () => {
    const ws = fresh();
    const a = plainDir('a');
    const b = plainDir('b');
    const project = await createProject(ws, { name: 'Both', folders: [a, b] });
    expect(await ensureProject(ws, b)).toEqual({ created: false, project });
  });

  it('names a new project uniquely when its directory name is taken', async () => {
    const ws = fresh();
    await createProject(ws, { name: 'plain' });
    expect((await ensureProject(ws, plainDir('plain'))).project.name).toMatch(/^plain \(.+\)$/);
  });

  it('still refuses a directory that is already registered, by name', async () => {
    const ws = fresh();
    const dir = plainDir();
    await registerProject(ws, dir, 'Here');
    await expect(registerProject(ws, dir)).rejects.toThrow(`${dir} is already registered as Here.`);
  });
});
