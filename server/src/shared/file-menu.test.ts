// The Changes panel's right-click menu: what a changed file offers, a deleted one, and what picks mean.
import { describe, expect, test } from 'vitest';
import { absolutePath, changedFileMenu, filePick, parentOf, type FileMenuContext, defaultFolderApp, openInMenu, sanitizeOpenInPrefs } from './file-menu.ts';

const editors = [
  { id: 'vscode', label: 'VS Code' },
  { id: 'default', label: 'Default app' },
];
const ctx: FileMenuContext = { folder: '/w/s1/', editors, reveal: true, shown: false };
const labels = (items: { label: string }[]) => items.map((i) => i.label);

describe('changedFileMenu', () => {
  test('a changed file: its diff, each editor, Finder, then both paths', () => {
    const items = changedFileMenu({ path: 'src/app.ts', status: 'M' }, ctx);
    expect(labels(items)).toEqual(['Show diff', 'Open in VS Code', 'Open with default app', 'Show in Finder', 'Copy path', 'Copy relative path']);
    expect(items.filter((i) => i.separatorBefore).map((i) => i.id)).toEqual(['open:vscode', 'copy-path']);
    expect(items.find((i) => i.id === 'copy-path')?.action).toEqual({ type: 'copy', text: '/w/s1/src/app.ts', what: 'path' });
    expect(items.find((i) => i.id === 'copy-relative-path')?.action).toEqual({ type: 'copy', text: 'src/app.ts', what: 'relative path' });
  });

  test('the diff on screen is not offered again', () => {
    expect(labels(changedFileMenu({ path: 'a.ts', status: 'A' }, { ...ctx, shown: true }))[0]).toBe('Open in VS Code');
  });

  test('a deleted file has nothing to open: its folder in Finder and the copies', () => {
    const items = changedFileMenu({ path: 'src/old.ts', status: 'D' }, ctx);
    expect(labels(items)).toEqual(['Show diff', 'Show folder in Finder', 'Copy path', 'Copy relative path']);
  });

  test('no editors and no Finder (not a Mac): only the copies', () => {
    const items = changedFileMenu({ path: 'a.ts', status: 'M' }, { ...ctx, editors: [], reveal: false, shown: true });
    expect(labels(items)).toEqual(['Copy path', 'Copy relative path']);
    expect(items[0]!.separatorBefore).toBeUndefined();
  });

  test('no folder on disk: no absolute path to copy', () => {
    expect(labels(changedFileMenu({ path: 'a.ts', status: 'M' }, { ...ctx, folder: null, editors: [], reveal: false, shown: true }))).toEqual(['Copy relative path']);
  });
});

describe('filePick', () => {
  const file = { path: 'src/deep/x.ts', status: 'M' as const };
  test('each item names what it asks for; copies carry their own action', () => {
    expect(filePick({ id: 'show-diff' }, file)).toEqual({ kind: 'show-diff' });
    expect(filePick({ id: 'open:vscode' }, file)).toEqual({ kind: 'open', editorId: 'vscode' });
    expect(filePick({ id: 'reveal' }, file)).toEqual({ kind: 'reveal', path: 'src/deep/x.ts' });
    expect(filePick({ id: 'reveal-folder' }, file)).toEqual({ kind: 'reveal', path: 'src/deep' });
    expect(filePick({ id: 'copy-path' }, file)).toBeNull();
  });

  test('paths', () => {
    expect(parentOf('top.ts')).toBe('');
    expect(absolutePath('/w/', '/a/b')).toBe('/w/a/b');
  });
});

describe('the Open in menu of a pane', () => {
  const apps = [
    { id: 'vscode', label: 'VS Code', kind: 'editor' as const },
    { id: 'cursor', label: 'Cursor', kind: 'editor' as const },
    { id: 'finder', label: 'Finder', kind: 'finder' as const },
    { id: 'terminal', label: 'Terminal', kind: 'terminal' as const },
    { id: 'iterm', label: 'iTerm', kind: 'terminal' as const },
  ];
  test('lists each app, opening the pane\'s folder in it, with a line between editors, Finder and terminals', () => {
    const menu = openInMenu(apps, 'session:s1');
    expect(menu.map((i) => [i.label, i.separatorBefore === true])).toEqual([['VS Code', false], ['Cursor', false], ['Finder', true], ['Terminal', true], ['iTerm', false]]);
    expect(menu[1]!.action).toEqual({ type: 'open-folder', scope: 'session:s1', appId: 'cursor' });
  });
  test('shows each app\'s icon and marks the one the button opens with', () => {
    const menu = openInMenu([{ ...apps[0]!, icon: 'data:image/png;base64,AAAA' }, apps[1]!], 'session:s1', 'cursor');
    expect(menu.map((i) => [i.label, i.icon, i.value])).toEqual([['VS Code', 'data:image/png;base64,AAAA', undefined], ['Cursor', undefined, 'Default']]);
  });
  test('the button opens with the chosen app, else VS Code, else the first editor, else Finder', () => {
    const id = (list: typeof apps, chosen: string | null) => defaultFolderApp(list, chosen)?.id ?? null;
    expect(id(apps, 'iterm')).toBe('iterm');
    expect(id(apps, null)).toBe('vscode');
    // The chosen app was uninstalled since: Kestrel's own choice again.
    expect(id(apps, 'zed')).toBe('vscode');
    expect(id(apps.slice(1), null)).toBe('cursor');
    expect(id(apps.slice(2), null)).toBe('finder');
    expect(id(apps.slice(3), null)).toBe('terminal');
    expect(id([], 'vscode')).toBeNull();
  });
  test('keeps only a plausible app id as the stored choice', () => {
    expect(sanitizeOpenInPrefs({ defaultApp: 'cursor' })).toEqual({ defaultApp: 'cursor' });
    for (const bad of [null, {}, { defaultApp: 7 }, { defaultApp: '' }, { defaultApp: '../etc' }, 'cursor']) expect(sanitizeOpenInPrefs(bad)).toEqual({ defaultApp: null });
  });
  test('says why when there is nothing to open with', () => {
    expect(openInMenu([], 'session:s1')).toEqual([{ id: 'open-in-none', label: 'Nothing here can open a folder', disabled: true, hint: 'Opening needs Kestrel to run on a Mac' }]);
  });
});
