// A store from before projects could have several directories opens with each project holding its
// one folder, under the project's own id, and keeps working from there.
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sqlitePersistence } from './sqlite.ts';

/** A store shaped as before: no directories table, no `started_folder_id`, one folder per project. */
async function oldStore(): Promise<string> {
  const path = join(mkdtempSync(join(tmpdir(), 'kestrel-sqlite-')), 'kestrel.db');
  await sqlitePersistence(path).close();
  const old = new DatabaseSync(path);
  old.exec('DROP TABLE project_folders; ALTER TABLE sessions DROP COLUMN started_folder_id;');
  const project = old.prepare('INSERT INTO projects (id, name, path, is_git) VALUES (?, ?, ?, ?)');
  project.run('wren', 'Wren', '/c/wren', 1);
  project.run('notes', 'Notes', '/c/notes', 0);
  old.prepare("INSERT INTO sessions (id, title, agent, state, note, started_in, created_at, updated_at) VALUES ('s1', 'Old work', 'claude', 'done', '', 'wren', 1, 1)").run();
  old.prepare("INSERT INTO pins (kind, id, pinned_at, position) VALUES ('project', 'wren', 1, 0)").run();
  old.close();
  return path;
}

describe('a store from before project directories', () => {
  it('gives each project exactly its one folder, with the project’s id, and leaves sessions and pins as they were', async () => {
    const db = sqlitePersistence(await oldStore());
    expect(await db.listProjects()).toEqual([
      { id: 'wren', name: 'Wren', folders: [{ id: 'wren', path: '/c/wren', isGit: true }], defaultFolderId: 'wren' },
      { id: 'notes', name: 'Notes', folders: [{ id: 'notes', path: '/c/notes', isGit: false }], defaultFolderId: 'notes' },
    ]);
    expect(await db.getSession('s1')).toMatchObject({ startedIn: 'wren', startedFolderId: null });
    expect((await db.listPins()).map((p) => p.id)).toEqual(['wren']);
    await db.close();
  });

  it('migrates once: after a restart a removed directory stays removed and new ones keep their order, the default with them', async () => {
    const path = await oldStore();
    const first = sqlitePersistence(path);
    await first.deleteFolder('notes', 'notes');
    await first.insertFolder('wren', { id: 'docs', path: '/c/docs', isGit: false });
    await first.setFolderOrder('wren', ['docs', 'wren']);
    await first.close();

    const again = sqlitePersistence(path);
    expect(await again.listProjects()).toEqual([
      { id: 'wren', name: 'Wren', folders: [{ id: 'docs', path: '/c/docs', isGit: false }, { id: 'wren', path: '/c/wren', isGit: true }], defaultFolderId: 'wren' },
      { id: 'notes', name: 'Notes', folders: [], defaultFolderId: null },
    ]);
    await again.close();
  });

  it('keeps the old columns equal to the default directory, so an older Kestrel can still read the store', async () => {
    const path = await oldStore();
    const db = sqlitePersistence(path);
    await db.insertFolder('wren', { id: 'docs', path: '/c/docs', isGit: false });
    await db.setFolderOrder('wren', ['docs', 'wren']);
    await db.setDefaultFolder('wren', 'docs');
    await db.deleteFolder('notes', 'notes');
    await db.close();
    const raw = new DatabaseSync(path);
    expect(raw.prepare('SELECT id, path, is_git FROM projects ORDER BY rowid').all()).toEqual([
      { id: 'wren', path: '/c/docs', is_git: 0 },
      { id: 'notes', path: '', is_git: 0 },
    ]);
    raw.close();
  });

  it('records the directory a new session started in', async () => {
    const db = sqlitePersistence(await oldStore());
    await db.insertSession({ id: 's2', title: 'New', agent: 'claude', state: 'running', note: '', startedIn: 'wren', startedFolderId: 'wren', landedIn: null, worktreePath: null, branch: null, worktreeDiscarded: false, groupId: null, createdAt: 2, updatedAt: 2 });
    expect(await db.getSession('s2')).toMatchObject({ startedFolderId: 'wren' });
    await db.close();
  });
});

/** A store in the shape before explicit defaults: directories table, no `default_folder_id`. Wren's folders are stored out of rowid order. */
async function storeWithoutDefaults(): Promise<string> {
  const path = join(mkdtempSync(join(tmpdir(), 'kestrel-sqlite-')), 'kestrel.db');
  await sqlitePersistence(path).close();
  const old = new DatabaseSync(path);
  old.exec('ALTER TABLE projects DROP COLUMN default_folder_id;');
  old.prepare("INSERT INTO projects (id, name, path, is_git) VALUES ('shop', 'Shop', '/c/api', 1), ('empty', 'Empty', '', 0)").run();
  const folder = old.prepare('INSERT INTO project_folders (id, project_id, path, is_git, position) VALUES (?, ?, ?, ?, ?)');
  folder.run('web', 'shop', '/c/web', 1, 1);
  folder.run('api', 'shop', '/c/api', 1, 0);
  old.close();
  return path;
}

describe('a project’s explicit default folder', () => {
  it('migrates a store with directories but no stored default: the first in order is the default', async () => {
    const db = sqlitePersistence(await storeWithoutDefaults());
    expect((await db.listProjects()).map((p) => [p.id, p.defaultFolderId])).toEqual([
      ['shop', 'api'],
      ['empty', null],
    ]);
    await db.close();
  });

  it('is set explicitly, survives a restart, and reordering never changes it', async () => {
    const path = await storeWithoutDefaults();
    const first = sqlitePersistence(path);
    await first.setDefaultFolder('shop', 'web');
    await first.setFolderOrder('shop', ['api', 'web']);
    await first.close();
    const again = sqlitePersistence(path);
    expect((await again.listProjects())[0]).toMatchObject({ defaultFolderId: 'web', folders: [{ id: 'api' }, { id: 'web' }] });
    await again.close();
    const raw = new DatabaseSync(path);
    expect(raw.prepare("SELECT path FROM projects WHERE id = 'shop'").get()).toEqual({ path: '/c/web' });
    raw.close();
  });

  it('ignores a folder that is not the project’s, and falls back to the first when the default is removed', async () => {
    const db = sqlitePersistence(await storeWithoutDefaults());
    await db.setDefaultFolder('shop', 'web');
    await db.setDefaultFolder('shop', 'nowhere');
    await db.setDefaultFolder('empty', 'web');
    expect((await db.listProjects()).map((p) => p.defaultFolderId)).toEqual(['web', null]);
    await db.deleteFolder('shop', 'web');
    expect((await db.listProjects())[0]!.defaultFolderId).toBe('api');
    await db.insertFolder('empty', { id: 'e1', path: '/c/e1', isGit: false });
    expect((await db.listProjects())[1]!.defaultFolderId).toBe('e1');
    await db.close();
  });

  it('keeps the default a new project is created with', async () => {
    const db = sqlitePersistence(await storeWithoutDefaults());
    await db.insertProject({ id: 'new', name: 'New', folders: [{ id: 'x', path: '/c/x', isGit: false }, { id: 'y', path: '/c/y', isGit: false }], defaultFolderId: 'y' });
    await db.insertProject({ id: 'bare', name: 'Bare', folders: [{ id: 'z', path: '/c/z', isGit: false }] });
    expect((await db.listProjects()).slice(2).map((p) => p.defaultFolderId)).toEqual(['y', 'z']);
    await db.close();
  });
});
