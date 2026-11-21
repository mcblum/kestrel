// Keyboard shortcuts (shared/shortcuts.ts): reading a key press, the user's keys over the
// defaults, conflicts, and how a key is shown and handed to the desktop app's menu.
import { describe, expect, it } from 'vitest';
import { acceleratorOf, assignProblem, bindingFor, bindingOf, bindingProblem, commandFor, formatBinding, menuAccelerators, sanitizeOverrides, searchShortcuts, SHORTCUT_COMMANDS, takenBy, withBinding, type KeyPress } from './shared/shortcuts.ts';

const press = (code: string, key: string, mods: Partial<Pick<KeyPress, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>> = {}): KeyPress => ({ code, key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

describe('reading a key press', () => {
  it('names the key by its place on the keyboard, so Shift does not change it', () => {
    expect(bindingOf(press('KeyN', 'n', { metaKey: true }), true)).toBe('mod+n');
    expect(bindingOf(press('BracketRight', '}', { metaKey: true, shiftKey: true }), true)).toBe('mod+shift+]');
    expect(bindingOf(press('Digit3', '#', { metaKey: true, shiftKey: true }), true)).toBe('mod+shift+3');
    expect(bindingOf(press('Backquote', '~', { ctrlKey: true, shiftKey: true }), true)).toBe('ctrl+shift+`');
  });

  it('takes Ctrl as mod off a Mac, and nothing from a modifier on its own', () => {
    expect(bindingOf(press('KeyK', 'k', { ctrlKey: true }), false)).toBe('mod+k');
    expect(bindingOf(press('KeyK', 'k', { ctrlKey: true }), true)).toBe('ctrl+k');
    expect(bindingOf(press('MetaLeft', 'Meta', { metaKey: true }), true)).toBeNull();
  });
});

describe('the keys in force', () => {
  it('are the defaults until changed, and run their commands', () => {
    expect(bindingFor({}, 'new-session')).toBe('mod+n');
    expect(commandFor({}, 'mod+k')).toBe('switch');
    expect(commandFor({}, 'mod+shift+]')).toBe('next-tab');
    expect(commandFor({}, 'mod+4')).toBe('tab:4');
    expect(commandFor({}, 'mod+j')).toBeNull();
    expect(commandFor({}, null)).toBeNull();
  });

  it('move with a change: the new key runs the command and the old one no longer does', () => {
    const changed = withBinding({}, 'switch', 'mod+p');
    expect(changed).toEqual({ switch: 'mod+p' });
    expect(commandFor(changed, 'mod+p')).toBe('switch');
    expect(commandFor(changed, 'mod+k')).toBeNull();
    expect(withBinding(changed, 'switch', 'mod+k')).toEqual({}); // back to its default: no override kept
    expect(commandFor(withBinding({}, 'toggle-sidebar', ''), 'mod+b')).toBeNull(); // taken away
  });

  it('refuse a key another command has, a reserved one, and one that could be typed by accident', () => {
    expect(assignProblem({}, 'switch', 'mod+n')).toBe('That is already "New session". Change that one first, or pick another key.');
    expect(takenBy({}, 'switch', 'mod+n')?.id).toBe('new-session');
    expect(assignProblem({ 'new-session': 'mod+j' }, 'switch', 'mod+n')).toBeNull(); // freed by the change
    expect(bindingProblem('k')).toMatch(/needs Cmd, Ctrl or Option/);
    expect(bindingProblem('shift+k')).toMatch(/needs Cmd, Ctrl or Option/);
    expect(bindingProblem('mod+3')).toBe('Cmd with 1 to 9 goes to a tab.');
    expect(bindingProblem('mod+c')).toBe('That is Copy.');
    expect(bindingProblem('shift+mod+k')).toBe('That is not a key Kestrel can read.');
    expect(withBinding({}, 'switch', 'mod+c')).toEqual({});
  });

  it('keep only readable changes from storage', () => {
    expect(sanitizeOverrides({ switch: 'mod+p', 'new-session': 'mod+n', nope: 'mod+j', 'close-tab': 'k', 'next-tab': 7 })).toEqual({ switch: 'mod+p' });
    expect(sanitizeOverrides('x')).toEqual({});
  });
});

describe('showing a key', () => {
  it('uses the Mac’s symbols on a Mac and words elsewhere', () => {
    expect(formatBinding('mod+shift+]', true)).toBe('⌘ ⇧ ]');
    expect(formatBinding('mod+n', false)).toBe('Ctrl N');
    expect(formatBinding('ctrl+alt+enter', true)).toBe('⌃ ⌥ ↵');
    expect(formatBinding('mod+1 … mod+9', true)).toBe('⌘ 1 … ⌘ 9');
    expect(formatBinding('', true)).toBe('');
  });

  it('gives the desktop app’s menu each command’s accelerator', () => {
    expect(acceleratorOf('mod+shift+]')).toBe('CmdOrCtrl+Shift+]');
    expect(acceleratorOf('ctrl+alt+enter')).toBe('Ctrl+Alt+Return');
    expect(menuAccelerators({ switch: 'mod+p', 'toggle-sidebar': '' })).toMatchObject({ 'new-session': 'CmdOrCtrl+N', switch: 'CmdOrCtrl+P', 'toggle-sidebar': '' });
    expect(Object.keys(menuAccelerators({}))).toEqual(SHORTCUT_COMMANDS.map((c) => c.id));
  });

  it('finds a shortcut by what it does or by its keys', () => {
    expect(searchShortcuts('sidebar', {}, true).commands.map((c) => c.id)).toEqual(['toggle-sidebar']);
    expect(searchShortcuts('⌘ k', {}, true).commands.map((c) => c.id)).toEqual(['switch']);
    expect(searchShortcuts('terminal', {}, true).fixed.map((f) => f.label)).toEqual(['New terminal (in the Terminal pane)']);
    expect(searchShortcuts('', {}, true).commands).toHaveLength(SHORTCUT_COMMANDS.length);
  });
});
