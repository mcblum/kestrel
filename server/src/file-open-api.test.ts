// Opening a session's file and showing it in Finder: editor detection over a fake lookup, and the
// routes with a stand-in runner, so no test ever opens an app or Finder.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { detectEditors, detectFolderApps } from './editors.ts';
import { OpenIn } from './open-in/prefs.ts';
import { fileOpenRoute, type FileOpenDeps } from './file-open-api.ts';

describe('detectEditors', () => {
  test('lists only the installed editors, in order, then the default app', () => {
    const installed = new Set(['Zed', 'Visual Studio Code']);
    expect(detectEditors((app) => installed.has(app)).map((e) => e.id)).toEqual(['vscode', 'zed', 'default']);
  });

  test('none installed: the default app alone', () => {
    expect(detectEditors(() => false)).toEqual([{ id: 'default', label: 'Default app', app: null }]);
  });
});

describe('fileOpenRoute', () => {
  let root: string;
  let folder: string;
  let calls: [string, readonly string[]][];
  let deps: FileOpenDeps;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-open-')));
    folder = join(root, 'session');
    mkdirSync(join(folder, 'src'), { recursive: true });
    writeFileSync(join(folder, 'src', 'app.ts'), 'x');
    writeFileSync(join(root, 'secret.txt'), 'outside');
    symlinkSync(join(root, 'secret.txt'), join(folder, 'link.txt'));
    calls = [];
    deps = {
      directoryOf: async (id) => (id === 's1' ? folder : id === 'gone' ? join(root, 'removed-worktree') : null),
      editors: () => detectEditors((app) => app === 'Cursor'),
      canOpen: true,
      run: async (command, args) => void calls.push([command, args]),
      folderApps: () => detectFolderApps((app) => app === 'Cursor' || app === 'Ghostty'),
      folderOf: async (scope) => (scope === 'session:s1' ? folder : scope === 'session:gone' ? join(root, 'removed-worktree') : null),
      folderAppIcons: async () => ({ cursor: 'data:image/png;base64,AAAA' }),
      openIn: new OpenIn(),
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const post = (action: string, body: Record<string, unknown>, id = 's1') => fileOpenRoute(['api', 'sessions', id, action], 'POST', async () => body, deps);

  test('GET /api/editors: the detected editors without their app names', async () => {
    expect(await fileOpenRoute(['api', 'editors'], 'GET', async () => ({}), deps)).toEqual({
      status: 200,
      body: { editors: [{ id: 'cursor', label: 'Cursor' }, { id: 'default', label: 'Default app' }], reveal: true },
    });
    expect((await fileOpenRoute(['api', 'editors'], 'GET', async () => ({}), { ...deps, canOpen: false }))?.body).toEqual({ editors: [], reveal: false });
  });

  test('opens the file in the editor with an argument array', async () => {
    expect(await post('open-file', { path: 'src/app.ts', editor: 'cursor' })).toEqual({ status: 204 });
    expect(await post('open-file', { path: 'src/app.ts', editor: 'default' })).toEqual({ status: 204 });
    const file = join(folder, 'src', 'app.ts');
    expect(calls).toEqual([
      ['/usr/bin/open', ['-a', 'Cursor', file]],
      ['/usr/bin/open', [file]],
    ]);
  });

  test('shows a file, or a deleted file’s folder, in Finder', async () => {
    expect(await post('reveal-file', { path: 'src/app.ts' })).toEqual({ status: 204 });
    expect(await post('reveal-file', { path: 'src' })).toEqual({ status: 204 });
    expect(calls).toEqual([
      ['/usr/bin/open', ['-R', join(folder, 'src', 'app.ts')]],
      ['/usr/bin/open', ['-R', join(folder, 'src')]],
    ]);
  });

  test('a path outside the session’s folder is refused, by .., by an absolute path or through a symlink', async () => {
    for (const path of ['../secret.txt', join(root, 'secret.txt'), 'link.txt']) {
      const answer = await post('open-file', { path, editor: 'cursor' });
      expect(answer?.status).toBe(404);
      expect((answer?.body as { error: string }).error).toMatch(/outside/);
    }
    expect((await post('reveal-file', { path: '../secret.txt' }))?.status).toBe(404);
    expect(calls).toEqual([]);
  });

  test('an editor that was not detected is refused', async () => {
    const answer = await post('open-file', { path: 'src/app.ts', editor: 'vscode' });
    expect(answer).toEqual({ status: 400, body: { error: 'vscode is not an editor Kestrel found on this Mac.' } });
    expect((await post('open-file', { path: 'src/app.ts' }))?.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test('a malformed body, a folder to open, a missing file or session folder are refused', async () => {
    expect((await post('open-file', { path: 42, editor: 'cursor' }))?.status).toBe(400);
    expect((await post('open-file', { path: '', editor: 'cursor' }))?.status).toBe(400);
    expect((await post('open-file', { path: 'src', editor: 'cursor' }))?.status).toBe(400);
    expect((await post('open-file', { path: 'gone.ts', editor: 'cursor' }))?.status).toBe(404);
    expect((await post('reveal-file', { path: 'a.ts' }, 'other'))?.status).toBe(409);
    expect((await post('reveal-file', { path: 'a.ts' }, 'gone'))?.status).toBe(409);
    expect(calls).toEqual([]);
  });

  test('not a Mac: refused; a failing command: its reason', async () => {
    expect((await fileOpenRoute(['api', 'sessions', 's1', 'reveal-file'], 'POST', async () => ({ path: 'src' }), { ...deps, canOpen: false }))?.status).toBe(409);
    deps.run = async () => {
      throw new Error('LSOpen failed');
    };
    expect(await post('reveal-file', { path: 'src' })).toEqual({ status: 409, body: { error: 'macOS could not show it: LSOpen failed' } });
  });

  describe('opening the folder a pane shows', () => {
    const open = (body: Record<string, unknown>, with_: Partial<FileOpenDeps> = {}) => fileOpenRoute(['api', 'open-folder'], 'POST', async () => body, { ...deps, ...with_ });

    const apps = [
      { id: 'cursor', label: 'Cursor', kind: 'editor', icon: 'data:image/png;base64,AAAA' },
      { id: 'finder', label: 'Finder', kind: 'finder' },
      { id: 'terminal', label: 'Terminal', kind: 'terminal' },
      { id: 'ghostty', label: 'Ghostty', kind: 'terminal' },
    ];
    const list = (method: string, body: Record<string, unknown> = {}, with_: Partial<FileOpenDeps> = {}) => fileOpenRoute(['api', 'folder-apps'], method, async () => body, { ...deps, ...with_ });

    test('GET /api/folder-apps: the installed editors, Finder, Terminal and the installed terminals, with icons and without app names', async () => {
      // VS Code is not installed here, so the first editor found is what the button opens with.
      expect(await list('GET')).toEqual({ status: 200, body: { apps, defaultApp: 'cursor', chosen: null } });
      expect(await list('GET', {}, { canOpen: false })).toEqual({ status: 200, body: { apps: [], defaultApp: null, chosen: null } });
    });

    test('the default is VS Code when it is installed and nothing is chosen', async () => {
      const withCode = { folderApps: () => detectFolderApps((app) => app === 'Cursor' || app === 'Visual Studio Code') };
      expect(((await list('GET', {}, withCode))!.body as { defaultApp: string }).defaultApp).toBe('vscode');
    });

    test('PATCH /api/folder-apps: the user\'s choice is kept and becomes the default; null goes back to Kestrel\'s own', async () => {
      expect(await list('PATCH', { defaultApp: 'ghostty' })).toEqual({ status: 200, body: { apps, defaultApp: 'ghostty', chosen: 'ghostty' } });
      expect(await list('GET')).toMatchObject({ body: { defaultApp: 'ghostty', chosen: 'ghostty' } });
      expect(await list('PATCH', { defaultApp: null })).toMatchObject({ body: { defaultApp: 'cursor', chosen: null } });
    });

    test('refuses an app that is not on this Mac as the default, with the reason', async () => {
      expect(await list('PATCH', { defaultApp: 'vscode' })).toEqual({ status: 400, body: { error: 'defaultApp must be an app Kestrel found on this Mac, or null for its own choice' } });
      expect(await list('PATCH', { defaultApp: 7 })).toMatchObject({ status: 400 });
      expect(await list('GET')).toMatchObject({ body: { chosen: null } });
    });

    test('an icon that cannot be read leaves the app listed without one', async () => {
      const failing = { folderAppIcons: async () => { throw new Error('sips failed'); } };
      expect(((await list('GET', {}, failing))!.body as { apps: { icon?: string }[] }).apps.every((a) => a.icon === undefined)).toBe(true);
    });

    test('opens the scope\'s folder in the app, and in Finder with no app name', async () => {
      expect(await open({ scope: 'session:s1', app: 'cursor' })).toEqual({ status: 204 });
      expect(await open({ scope: 'session:s1', app: 'finder' })).toEqual({ status: 204 });
      expect(await open({ scope: 'session:s1', app: 'terminal' })).toEqual({ status: 204 });
      expect(calls).toEqual([
        ['/usr/bin/open', ['-a', 'Cursor', folder]],
        ['/usr/bin/open', [folder]],
        ['/usr/bin/open', ['-a', 'Terminal', folder]],
      ]);
    });

    test('the folder comes from the scope: a path in the request is ignored', async () => {
      await open({ scope: 'session:s1', app: 'finder', path: '/etc', folder: '/etc' });
      expect(calls).toEqual([['/usr/bin/open', [folder]]]);
    });

    test('refuses, with the reason, an app it did not find, a scope with no folder, and a folder that is gone', async () => {
      expect(await open({ scope: 'session:s1', app: 'vscode' })).toEqual({ status: 400, body: { error: 'vscode is not an app Kestrel found on this Mac.' } });
      expect(await open({ scope: 'session:s1' })).toEqual({ status: 400, body: { error: 'app is required' } });
      expect(await open({ app: 'finder' })).toEqual({ status: 400, body: { error: 'scope is required' } });
      expect(await open({ scope: 'session:nope', app: 'finder' })).toEqual({ status: 409, body: { error: 'There is no folder on disk to open here.' } });
      expect(await open({ scope: 'session:gone', app: 'finder' })).toEqual({ status: 409, body: { error: 'There is no folder on disk to open here.' } });
      expect((await open({ scope: 'session:s1', app: 'finder' }, { canOpen: false }))?.status).toBe(409);
      expect(calls).toEqual([]);
    });

    test('says why when macOS could not open it', async () => {
      const failing = { run: async () => { throw new Error('LSOpen failed'); } };
      expect(await open({ scope: 'session:s1', app: 'cursor' }, failing)).toEqual({ status: 409, body: { error: 'macOS could not open it in Cursor: LSOpen failed' } });
    });
  });

  test('other paths are not answered', async () => {
    expect(await fileOpenRoute(['api', 'sessions', 's1', 'tags'], 'POST', async () => ({}), deps)).toBeNull();
  });
});
