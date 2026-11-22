// Keyboard shortcuts as data (0.0.20, matt/kestrel#20): every command a key can run, the key it
// has unless changed, and the user's own keys over those. One table feeds the key handling in the
// page, the desktop app's menu, the hints drawn beside buttons and the list in Settings, so they
// cannot disagree. A binding is written `mod+shift+k`: modifiers in the order mod, ctrl, alt,
// shift, then one key. `mod` is Cmd on a Mac and Ctrl elsewhere. Pure and browser-safe.

export interface ShortcutCommand {
  /** The command the key runs (ui/src/commands.ts `runCommand`). */
  id: string;
  label: string;
  group: 'Sessions' | 'Tabs' | 'View';
  /** Its key unless the user chose another. */
  default: string;
}

export const SHORTCUT_COMMANDS: readonly ShortcutCommand[] = [
  { id: 'new-session', label: 'New session', group: 'Sessions', default: 'mod+n' },
  { id: 'new-tab', label: 'New session in a new tab', group: 'Sessions', default: 'mod+t' },
  { id: 'switch', label: 'Switch session or search', group: 'Sessions', default: 'mod+k' },
  { id: 'close-tab', label: 'Close tab', group: 'Tabs', default: 'mod+w' },
  { id: 'next-tab', label: 'Next tab', group: 'Tabs', default: 'mod+shift+]' },
  { id: 'prev-tab', label: 'Previous tab', group: 'Tabs', default: 'mod+shift+[' },
  { id: 'toggle-sidebar', label: 'Show or hide the sidebar', group: 'View', default: 'mod+b' },
  // A browser's own keys on a Mac. Windows and Linux browsers use Alt with the arrows, which is fixed below.
  { id: 'back', label: 'Back', group: 'View', default: 'mod+[' },
  { id: 'forward', label: 'Forward', group: 'View', default: 'mod+]' },
];

/** Shortcuts that are listed so they can be found, and cannot be changed. */
export const FIXED_SHORTCUTS: readonly { label: string; group: ShortcutCommand['group']; keys: string }[] = [
  { label: 'Go to tab 1 to 9', group: 'Tabs', keys: 'mod+1 … mod+9' },
  { label: 'New terminal (in the Terminal pane)', group: 'View', keys: 'ctrl+shift+`' },
  { label: 'Back and forward, on Windows and Linux', group: 'View', keys: 'alt+left … alt+right' },
];

/**
 * A browser's Back and Forward keys where they are not Cmd with a bracket: Alt with the left and
 * right arrows on Windows and Linux. Not on a Mac, where Option with an arrow moves the cursor a
 * word at a time. Always there beside the keys above, and not changeable.
 */
export function browserNavCommand(binding: string | null, mac: boolean): 'back' | 'forward' | null {
  if (mac) return null;
  return binding === 'alt+left' ? 'back' : binding === 'alt+right' ? 'forward' : null;
}

/** The user's own keys, by command id; '' takes a command's key away. A command not listed keeps its default. */
export type ShortcutOverrides = Readonly<Record<string, string>>;

const MODIFIERS = ['mod', 'ctrl', 'alt', 'shift'] as const;
type Modifier = (typeof MODIFIERS)[number];

/** A key as the keyboard names its position, so Shift does not change it (`]` stays `]`, not `}`). */
const CODE_KEYS: Readonly<Record<string, string>> = { BracketLeft: '[', BracketRight: ']', Backquote: '`', Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", Backslash: '\\', Space: 'space', Enter: 'enter', Tab: 'tab', Escape: 'escape', Backspace: 'backspace', Delete: 'delete', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

export interface KeyPress {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

function keyOf(press: KeyPress): string | null {
  if (/^Key[A-Z]$/.test(press.code)) return press.code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(press.code)) return press.code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(press.code)) return press.code.toLowerCase();
  if (CODE_KEYS[press.code]) return CODE_KEYS[press.code]!;
  return press.key.length === 1 ? press.key.toLowerCase() : null; // a bare modifier, or a key with no name here
}

/** The binding a key press is, or null for a modifier on its own. */
export function bindingOf(press: KeyPress, mac: boolean): string | null {
  const key = keyOf(press);
  if (!key) return null;
  const held: Modifier[] = [];
  if (mac ? press.metaKey : press.ctrlKey) held.push('mod');
  if (mac && press.ctrlKey) held.push('ctrl');
  if (press.altKey) held.push('alt');
  if (press.shiftKey) held.push('shift');
  return [...held, key].join('+');
}

const partsOf = (binding: string): { mods: Modifier[]; key: string } => {
  // The key may itself be "+", so only what comes before the last "+" is modifiers.
  const at = binding.endsWith('++') ? binding.length - 1 : binding.lastIndexOf('+');
  return at < 0 ? { mods: [], key: binding } : { mods: binding.slice(0, at).split('+') as Modifier[], key: binding.slice(at + 1) };
};

const EDITING: Readonly<Record<string, string>> = { 'mod+c': 'Copy', 'mod+v': 'Paste', 'mod+x': 'Cut', 'mod+a': 'Select all', 'mod+z': 'Undo', 'mod+shift+z': 'Redo', 'mod+q': 'Quit', 'mod+shift+w': 'Close window', 'mod+r': 'Reload', 'ctrl+shift+`': 'New terminal' };

/** Why `binding` cannot be a shortcut, or null when it can ('' is no shortcut). */
export function bindingProblem(binding: string): string | null {
  if (!binding) return null;
  const { mods, key } = partsOf(binding);
  if (!key || mods.some((m) => !MODIFIERS.includes(m)) || MODIFIERS.filter((m) => mods.includes(m)).join('+') !== mods.join('+')) return 'That is not a key Kestrel can read.';
  if (!mods.some((m) => m === 'mod' || m === 'ctrl' || m === 'alt')) return 'A shortcut needs Cmd, Ctrl or Option, so it cannot be typed by accident.';
  if (mods.length === 1 && mods[0] === 'mod' && /^[1-9]$/.test(key)) return 'Cmd with 1 to 9 goes to a tab.';
  return EDITING[binding] ? `That is ${EDITING[binding]}.` : null;
}

export function sanitizeOverrides(value: unknown): ShortcutOverrides {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [id, binding] of Object.entries(value)) {
    const command = SHORTCUT_COMMANDS.find((c) => c.id === id);
    if (command && typeof binding === 'string' && bindingProblem(binding) === null && binding !== command.default) out[id] = binding;
  }
  return out;
}

/** The key a command has now: the user's, else its default; '' when the user took it away. */
export const bindingFor = (overrides: ShortcutOverrides, id: string): string => overrides[id] ?? SHORTCUT_COMMANDS.find((c) => c.id === id)?.default ?? '';

/** The other command that already has `binding`, if any. */
export const takenBy = (overrides: ShortcutOverrides, id: string, binding: string): ShortcutCommand | undefined => (binding ? SHORTCUT_COMMANDS.find((c) => c.id !== id && bindingFor(overrides, c.id) === binding) : undefined);

/** Why `binding` cannot be given to command `id`, or null when it can. */
export function assignProblem(overrides: ShortcutOverrides, id: string, binding: string): string | null {
  const problem = bindingProblem(binding);
  if (problem) return problem;
  const other = takenBy(overrides, id, binding);
  return other ? `That is already "${other.label}". Change that one first, or pick another key.` : null;
}

/** The overrides with command `id` given `binding` (its default removes the override); refused bindings change nothing. */
export function withBinding(overrides: ShortcutOverrides, id: string, binding: string): ShortcutOverrides {
  const command = SHORTCUT_COMMANDS.find((c) => c.id === id);
  if (!command || assignProblem(overrides, id, binding) !== null) return overrides;
  const { [id]: _old, ...rest } = overrides;
  return binding === command.default ? rest : { ...rest, [id]: binding };
}

/** The command a binding runs: a changed or default key, or Cmd with 1 to 9 for a tab. */
export function commandFor(overrides: ShortcutOverrides, binding: string | null): string | null {
  if (!binding) return null;
  const command = SHORTCUT_COMMANDS.find((c) => bindingFor(overrides, c.id) === binding);
  if (command) return command.id;
  const tab = /^mod\+([1-9])$/.exec(binding);
  return tab ? `tab:${tab[1]}` : null;
}

const MAC_MOD: Record<Modifier, string> = { mod: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' };
const PC_MOD: Record<Modifier, string> = { mod: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' };
const KEY_NAME: Readonly<Record<string, string>> = { space: 'Space', enter: '↵', tab: 'Tab', escape: 'Esc', backspace: '⌫', delete: 'Del', up: '↑', down: '↓', left: '←', right: '→' };

/** A binding as shown: "⌘ ⇧ ]" on a Mac, "Ctrl Shift ]" elsewhere; '' for none. */
export function formatBinding(binding: string, mac: boolean): string {
  if (!binding) return '';
  if (binding.includes('…')) return binding.split(' … ').map((b) => formatBinding(b, mac)).join(' … ');
  const { mods, key } = partsOf(binding);
  return [...mods.map((m) => (mac ? MAC_MOD : PC_MOD)[m]), KEY_NAME[key] ?? (key.length === 1 ? key.toUpperCase() : key.toUpperCase())].join(' ');
}

const ACCEL_MOD: Record<Modifier, string> = { mod: 'CmdOrCtrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' };
const ACCEL_KEY: Readonly<Record<string, string>> = { space: 'Space', enter: 'Return', tab: 'Tab', escape: 'Esc', backspace: 'Backspace', delete: 'Delete', up: 'Up', down: 'Down', left: 'Left', right: 'Right', '+': 'Plus' };

/** A binding as the desktop app's menu wants it ("CmdOrCtrl+Shift+]"); '' for none. */
export function acceleratorOf(binding: string): string {
  if (!binding) return '';
  const { mods, key } = partsOf(binding);
  return [...mods.map((m) => ACCEL_MOD[m]), ACCEL_KEY[key] ?? key.toUpperCase()].join('+');
}

/** Every command's accelerator for the desktop app's menu, by command id. */
export const menuAccelerators = (overrides: ShortcutOverrides): Record<string, string> => Object.fromEntries(SHORTCUT_COMMANDS.map((c) => [c.id, acceleratorOf(bindingFor(overrides, c.id))]));

/** The rows the Settings list shows for a search: by what the command is called or its keys. */
export function searchShortcuts(query: string, overrides: ShortcutOverrides, mac: boolean): { commands: ShortcutCommand[]; fixed: typeof FIXED_SHORTCUTS } {
  const q = query.trim().toLowerCase();
  const hit = (label: string, keys: string) => !q || label.toLowerCase().includes(q) || keys.toLowerCase().replace(/\s+/g, '').includes(q.replace(/\s+/g, ''));
  return { commands: SHORTCUT_COMMANDS.filter((c) => hit(c.label, formatBinding(bindingFor(overrides, c.id), mac))), fixed: FIXED_SHORTCUTS.filter((f) => hit(f.label, formatBinding(f.keys, mac))) };
}
