import { describe, expect, test } from 'vitest';
import { openersFor, type OpenerLookup } from './openers.ts';

const look = (present: readonly string[], env: Record<string, string> = {}, folders: readonly string[] = []): OpenerLookup => ({ exists: (path) => present.includes(path.replace(/\\/g, '/')), isFolder: (path) => folders.includes(path), env, home: '/home/someone' });
const ids = (list: readonly { id: string }[]) => list.map((item) => item.id);

describe('Linux', () => {
  const openers = openersFor('linux', look(['/usr/bin/code', '/usr/local/bin/zeditor'], { PATH: '/usr/local/bin:/usr/bin' }, ['/work/repo']));

  test('finds an editor by its command on PATH, then offers the default app', () => {
    expect(ids(openers.editors)).toEqual(['vscode', 'zed', 'default']);
    expect(openers.editors[0]).toMatchObject({ label: 'VS Code', command: '/usr/bin/code' });
  });

  test('opens a file with the editor’s command, or xdg-open for the default app', () => {
    expect(openers.openFile(openers.editors[0]!, '/work/repo/a.ts')).toEqual({ command: '/usr/bin/code', args: ['/work/repo/a.ts'] });
    expect(openers.openFile(openers.editors.at(-1)!, '/work/repo/a.ts')).toEqual({ command: 'xdg-open', args: ['/work/repo/a.ts'] });
  });

  test('showing a file opens the folder it is in; showing a folder opens it', () => {
    expect(openers.reveal('/work/repo/src/a.ts')).toEqual({ command: 'xdg-open', args: ['/work/repo/src'] });
    expect(openers.reveal('/work/repo')).toEqual({ command: 'xdg-open', args: ['/work/repo'] });
  });

  test('a folder opens in the editors and the file manager; no terminals and no Xcode', () => {
    expect(ids(openers.folderApps)).toEqual(['vscode', 'zed', 'finder']);
    expect(openers.folderApps.at(-1)).toMatchObject({ label: 'File manager', kind: 'finder' });
    expect(openers.openFolder(openers.folderApps.at(-1)!, '/work/repo')).toEqual({ command: 'xdg-open', args: ['/work/repo'] });
    expect(openers.openFolder(openers.folderApps[0]!, '/work/repo')).toEqual({ command: '/usr/bin/code', args: ['/work/repo'] });
  });

  test('with no editor installed the default app and the file manager are still there', () => {
    const bare = openersFor('linux', look([], { PATH: '/usr/bin' }));
    expect(ids(bare.editors)).toEqual(['default']);
    expect(ids(bare.folderApps)).toEqual(['finder']);
  });
});

describe('Windows', () => {
  const env = { LOCALAPPDATA: 'C:/Users/someone/AppData/Local', ProgramFiles: 'C:/Program Files' };
  const openers = openersFor('windows', look(['C:/Users/someone/AppData/Local/Programs/cursor/Cursor.exe', 'C:/Program Files/Sublime Text/sublime_text.exe'], env));

  test('finds an editor where its installer puts it', () => {
    expect(ids(openers.editors)).toEqual(['cursor', 'sublime', 'default']);
  });

  test('the default app and File Explorer are explorer.exe, whose exit code is ignored', () => {
    expect(openers.openFile(openers.editors.at(-1)!, 'C:\\work\\a.ts')).toEqual({ command: 'explorer.exe', args: ['C:\\work\\a.ts'], anyExit: true });
    expect(openers.reveal('C:\\work\\a.ts')).toEqual({ command: 'explorer.exe', args: ['/select,C:\\work\\a.ts'], anyExit: true });
    expect(openers.folderApps.at(-1)).toMatchObject({ id: 'finder', label: 'File Explorer' });
    expect(openers.openFolder(openers.folderApps.at(-1)!, 'C:\\work')).toEqual({ command: 'explorer.exe', args: ['C:\\work'], anyExit: true });
  });

  test('an editor opens a file by its own program, with the path as one argument', () => {
    const launch = openers.openFile(openers.editors[0]!, 'C:\\work\\a b.ts');
    expect(launch.args).toEqual(['C:\\work\\a b.ts']);
    expect(launch.anyExit).toBeUndefined();
  });
});

describe('macOS', () => {
  const openers = openersFor('mac', look([]));

  test('opens through `open`, as before', () => {
    expect(openers.reveal('/work/a.ts')).toEqual({ command: '/usr/bin/open', args: ['-R', '/work/a.ts'] });
    expect(openers.openFile({ id: 'cursor', label: 'Cursor', app: 'Cursor' }, '/work/a.ts')).toEqual({ command: '/usr/bin/open', args: ['-a', 'Cursor', '/work/a.ts'] });
    expect(openers.openFolder({ id: 'finder', label: 'Finder', app: null, kind: 'finder' }, '/work')).toEqual({ command: '/usr/bin/open', args: ['/work'] });
  });
});
