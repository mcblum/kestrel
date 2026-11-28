// Keyboard shortcuts (shared/shortcuts.ts): reading a key press, the user's keys over the
// defaults, conflicts, how a key is shown and handed to the desktop app's menu, and Cmd with an
// arrow on a Mac.
import { describe, expect, it } from 'vitest';
import { acceleratorOf, arrowNavCommand, assignProblem, bindingFor, bindingOf, bindingProblem, browserNavCommand, commandFor, formatBinding, handleArrowNavKey, macArrowNavCommand, menuAccelerators, sanitizeOverrides, searchShortcuts, SHORTCUT_COMMANDS, takenBy, withBinding, type KeyPress, type KeyTarget, type ShortcutOverrides } from './shared/shortcuts.ts';

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

describe('Cmd with an arrow on a Mac: Back and Forward, never while typing', () => {
  // A stand-in for an element: as much as `keepsArrowKeys` reads, with its parents.
  interface Fake extends KeyTarget { parentElement: Fake | null }
  const el = (tagName: string, opts: { parent?: Fake | null; attrs?: Record<string, string>; classes?: string[]; editable?: boolean } = {}): Fake => ({
    tagName,
    isContentEditable: opts.editable ?? false,
    getAttribute: (name) => opts.attrs?.[name] ?? null,
    classList: { contains: (token) => (opts.classes ?? []).includes(token) },
    parentElement: opts.parent ?? null,
  });
  const body = el('BODY', { parent: el('HTML') });
  const page = el('DIV', { parent: body, classes: ['page'] });
  const keydown = (code: string, key: string, target: unknown, mods: Partial<Pick<KeyPress, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>> = { metaKey: true }, extra: { defaultPrevented?: boolean; isComposing?: boolean } = {}) => {
    const prevented = { count: 0 };
    const event = { ...press(code, key, mods), target, defaultPrevented: extra.defaultPrevented ?? false, isComposing: extra.isComposing ?? false, preventDefault: () => void prevented.count++ };
    return { event, prevented };
  };
  const left = (target: unknown, mods?: Parameters<typeof keydown>[3], extra?: Parameters<typeof keydown>[4]) => keydown('ArrowLeft', 'ArrowLeft', target, mods, extra);
  const right = (target: unknown, mods?: Parameters<typeof keydown>[3]) => keydown('ArrowRight', 'ArrowRight', target, mods);
  /** Hand a key press to the page's handler on a Mac; what it ran, and how often it prevented the key. */
  const handle = ({ event, prevented }: ReturnType<typeof keydown>, mac = true, overrides: ShortcutOverrides = {}) => {
    const ran: string[] = [];
    handleArrowNavKey(event, mac, overrides, (command) => ran.push(command));
    return { ran, prevented: prevented.count };
  };

  it('goes Back on Cmd ← and Forward on Cmd → when nothing typed into has the focus, and takes the key', () => {
    expect(handle(left(body))).toEqual({ ran: ['back'], prevented: 1 });
    expect(handle(right(page))).toEqual({ ran: ['forward'], prevented: 1 });
    expect(handle(left(el('BUTTON', { parent: page })))).toEqual({ ran: ['back'], prevented: 1 });
    expect(handle(left(null))).toEqual({ ran: ['back'], prevented: 1 }); // nothing focused at all
  });

  it('leaves the key untouched in an input, a text area, editable content and the message box', () => {
    const untouched = { ran: [], prevented: 0 };
    expect(handle(left(el('INPUT', { parent: page, attrs: { type: 'text' } })))).toEqual(untouched);
    expect(handle(right(el('input', { parent: page, attrs: { type: 'search' } })))).toEqual(untouched);
    expect(handle(left(el('TEXTAREA', { parent: page })))).toEqual(untouched);
    expect(handle(left(el('SELECT', { parent: page })))).toEqual(untouched);
    expect(handle(left(el('DIV', { parent: page, attrs: { contenteditable: 'true' }, editable: true })))).toEqual(untouched);
    // Read by the attribute too, where isContentEditable is not there to say.
    expect(handle(left(el('DIV', { parent: page, attrs: { contenteditable: '' } })))).toEqual(untouched);
    const composer = el('DIV', { parent: el('DIV', { parent: page, classes: ['composer-dock'] }), classes: ['composer-input'], attrs: { contenteditable: 'plaintext-only', role: 'textbox' }, editable: true });
    expect(handle(left(composer))).toEqual(untouched);
    expect(handle(right(composer))).toEqual(untouched);
    expect(handle(left(el('SPAN', { parent: composer, editable: true })))).toEqual(untouched); // a code span inside it
    expect(handle(left(el('DIV', { parent: page, attrs: { contenteditable: 'false' } })))).toEqual({ ran: ['back'], prevented: 1 });
  });

  it('leaves the key untouched in the terminal, a code editor, a custom text box and the browser pane', () => {
    const untouched = { ran: [], prevented: 0 };
    const terminal = el('DIV', { parent: page, classes: ['xterm'] });
    expect(handle(left(el('TEXTAREA', { parent: terminal, classes: ['xterm-helper-textarea'] })))).toEqual(untouched);
    expect(handle(left(el('DIV', { parent: terminal, classes: ['xterm-screen'] })))).toEqual(untouched);
    expect(handle(left(el('DIV', { parent: el('DIV', { parent: page, classes: ['cm-editor'] }) })))).toEqual(untouched);
    expect(handle(left(el('DIV', { parent: page, attrs: { role: 'textbox' } })))).toEqual(untouched);
    expect(handle(left(el('DIV', { parent: page, attrs: { role: 'combobox' } })))).toEqual(untouched);
    expect(handle(left(el('WEBVIEW', { parent: page })))).toEqual(untouched);
    expect(handle(left(el('IFRAME', { parent: page })))).toEqual(untouched);
  });

  it('is Cmd alone: with Shift, Option or Control the keys select or move by word, and are left alone', () => {
    const untouched = { ran: [], prevented: 0 };
    expect(handle(left(body, { metaKey: true, shiftKey: true }))).toEqual(untouched);
    expect(handle(right(body, { metaKey: true, shiftKey: true }))).toEqual(untouched);
    expect(handle(left(body, { metaKey: true, altKey: true }))).toEqual(untouched);
    expect(handle(left(body, { metaKey: true, ctrlKey: true }))).toEqual(untouched);
    expect(handle(left(body, {}))).toEqual(untouched);
    expect(handle(left(body, { altKey: true }))).toEqual(untouched);
    expect(handle(keydown('ArrowUp', 'ArrowUp', body))).toEqual(untouched);
  });

  it('leaves a key something on the way already handled, and one typed while composing text', () => {
    const untouched = { ran: [], prevented: 0 };
    expect(handle(left(body, { metaKey: true }, { defaultPrevented: true }))).toEqual(untouched);
    expect(handle(left(body, { metaKey: true }, { isComposing: true }))).toEqual(untouched);
  });

  it('gives way to a command the user put on that key', () => {
    expect(handle(left(body), true, { switch: 'mod+left' })).toEqual({ ran: [], prevented: 0 });
    expect(handle(right(body), true, { switch: 'mod+left' })).toEqual({ ran: ['forward'], prevented: 1 });
    // Back moved to another key: Cmd ← still goes back, beside it.
    expect(handle(left(body), true, { back: 'mod+alt+b' })).toEqual({ ran: ['back'], prevented: 1 });
  });

  it('does nothing on Windows and Linux, where Ctrl with an arrow moves by word and Alt with an arrow is Back and Forward', () => {
    const untouched = { ran: [], prevented: 0 };
    expect(handle(left(body, { ctrlKey: true }), false)).toEqual(untouched);
    expect(handle(right(body, { ctrlKey: true }), false)).toEqual(untouched);
    expect(handle(left(body, { metaKey: true }), false)).toEqual(untouched);
    expect(macArrowNavCommand('mod+left', false)).toBeNull();
    expect(browserNavCommand('alt+left', false)).toBe('back');
    expect(browserNavCommand('mod+left', true)).toBeNull();
    expect(arrowNavCommand(left(body).event, true, {})).toBe('back');
  });

  it('lists each computer’s own fixed Back and Forward keys, and not the other’s', () => {
    expect(searchShortcuts('back', {}, true).fixed.map((f) => formatBinding(f.keys, true))).toEqual(['⌘ ← … ⌘ →']);
    expect(searchShortcuts('back', {}, false).fixed.map((f) => formatBinding(f.keys, false))).toEqual(['Alt ← … Alt →']);
    expect(searchShortcuts('', {}, true).fixed.map((f) => f.label)).toContain('Go to tab 1 to 9');
    expect(searchShortcuts('', {}, false).fixed.map((f) => f.label)).toContain('Go to tab 1 to 9');
  });
});
