// Keyboard input for the simulator: Mac key presses in the pane, the agent's text and named keys,
// all turned into HID keyboard usages (USB HID Usage Tables, page 0x07) that the simulator's
// keyboard takes with a US layout. Pure, so the pane and the server share one table.

/** One key going down or up. Usages are HID keyboard page codes. */
export interface KeyStep {
  usage: number;
  down: boolean;
}

export type Modifier = 'command' | 'shift' | 'option' | 'control';
export const MODIFIERS: readonly Modifier[] = ['command', 'shift', 'option', 'control'];
const MODIFIER_USAGE: Record<Modifier, number> = { control: 0xe0, shift: 0xe1, option: 0xe2, command: 0xe3 };

const RETURN = 0x28;
const TAB = 0x2b;
const SPACE = 0x2c;

/** KeyboardEvent.code -> usage: the physical key, so the device gets what a US keyboard has there. */
const CODE_USAGE: Record<string, number> = {
  Enter: RETURN, NumpadEnter: RETURN, Escape: 0x29, Backspace: 0x2a, Tab: TAB, Space: SPACE,
  Minus: 0x2d, Equal: 0x2e, BracketLeft: 0x2f, BracketRight: 0x30, Backslash: 0x31, Semicolon: 0x33,
  Quote: 0x34, Backquote: 0x35, Comma: 0x36, Period: 0x37, Slash: 0x38,
  Home: 0x4a, PageUp: 0x4b, Delete: 0x4c, End: 0x4d, PageDown: 0x4e,
  ArrowRight: 0x4f, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52,
};
for (let i = 0; i < 26; i++) CODE_USAGE[`Key${String.fromCharCode(65 + i)}`] = 0x04 + i;
for (let i = 1; i <= 9; i++) CODE_USAGE[`Digit${i}`] = 0x1e + i - 1;
CODE_USAGE.Digit0 = 0x27;

/** Names the agent's sim_key takes. */
export const KEY_NAMES: Record<string, number> = {
  return: RETURN, enter: RETURN, escape: 0x29, delete: 0x2a, backspace: 0x2a, forward_delete: 0x4c, tab: TAB, space: SPACE,
  up: 0x52, down: 0x51, left: 0x50, right: 0x4f, home: 0x4a, end: 0x4d, page_up: 0x4b, page_down: 0x4e,
};

/** Characters on a US keyboard: [usage, needs shift]. */
const CHAR_KEY = new Map<string, [number, boolean]>();
const row = (plain: string, shifted: string, usages: number[]) =>
  usages.forEach((u, i) => {
    CHAR_KEY.set(plain[i]!, [u, false]);
    CHAR_KEY.set(shifted[i]!, [u, true]);
  });
row('abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', Array.from({ length: 26 }, (_, i) => 0x04 + i));
row('1234567890', '!@#$%^&*()', [0x1e, 0x1f, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27]);
row("-=[]\\;'`,./", '_+{}|:"~<>?', [0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38]);
CHAR_KEY.set(' ', [SPACE, false]);
CHAR_KEY.set('\n', [RETURN, false]);
CHAR_KEY.set('\t', [TAB, false]);

/** A key pressed with modifiers held: modifiers down, key down and up, modifiers up in reverse. */
export function chord(usage: number, modifiers: readonly Modifier[] = []): KeyStep[] {
  const held = MODIFIERS.filter((m) => modifiers.includes(m)).map((m) => MODIFIER_USAGE[m]);
  return [...held.map((u) => ({ usage: u, down: true })), { usage, down: true }, { usage, down: false }, ...[...held].reverse().map((u) => ({ usage: u, down: false }))];
}

/** Text as key presses, or the characters a US keyboard cannot type. */
export function textToKeys(text: string): { ok: true; steps: KeyStep[] } | { ok: false; untypable: string[] } {
  const steps: KeyStep[] = [];
  const untypable = new Set<string>();
  for (const ch of text.replace(/\r\n?/g, '\n')) {
    const key = CHAR_KEY.get(ch);
    if (!key) untypable.add(ch);
    else steps.push(...chord(key[0], key[1] ? ['shift'] : []));
  }
  return untypable.size ? { ok: false, untypable: [...untypable] } : { ok: true, steps };
}

/** A named key ("return", "left", …) or a single typable character; null when unknown. */
export function namedKey(name: string, modifiers: readonly Modifier[] = []): KeyStep[] | null {
  const lower = name.toLowerCase();
  if (lower in KEY_NAMES) return chord(KEY_NAMES[lower]!, modifiers);
  const key = [...name].length === 1 ? CHAR_KEY.get(name) : undefined;
  if (!key) return null;
  return chord(key[0], key[1] && !modifiers.includes('shift') ? [...modifiers, 'shift'] : modifiers);
}

/** What the pane needs from a keydown. */
export interface KeyPress {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** ⌘ shortcuts the device gets: select all, copy, paste, cut, undo (⇧⌘Z redo). Every other ⌘ key stays Kestrel's. */
const DEVICE_COMMAND_KEYS = new Set(['KeyA', 'KeyC', 'KeyV', 'KeyX', 'KeyZ']);

/**
 * A key pressed while the simulator picture has focus: the keys to send to the device, or null when
 * the key belongs to Kestrel (its shortcuts: ⌘K, ⌘N, ⌘W, ⌘1–9, any Control chord …) or the device has
 * no such key (function keys, a modifier pressed alone).
 */
export function keyForDevice(e: KeyPress): KeyStep[] | null {
  if (e.ctrlKey) return null;
  if (e.metaKey && !DEVICE_COMMAND_KEYS.has(e.code)) return null;
  const usage = CODE_USAGE[e.code];
  if (usage === undefined) return null;
  const modifiers: Modifier[] = [];
  if (e.metaKey) modifiers.push('command');
  if (e.shiftKey) modifiers.push('shift');
  if (e.altKey) modifiers.push('option');
  return chord(usage, modifiers);
}

/** A list of key steps as sent over the wire: bounded, whole numbers, real usages. */
export function isKeySteps(value: unknown, max: number): value is KeyStep[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= max &&
    value.every((s) => typeof s === 'object' && s !== null && Number.isInteger((s as KeyStep).usage) && (s as KeyStep).usage >= 1 && (s as KeyStep).usage <= 0xffff && typeof (s as KeyStep).down === 'boolean')
  );
}
