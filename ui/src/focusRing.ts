// When focus rings show. Chrome draws :focus-visible after any key press, so focus that moves by
// itself (a dialog opening after Enter, a menu closing after Escape, the window coming back after
// Cmd-Tab) outlined buttons the user never tabbed to. Rings now show only while the user moves
// focus with the keyboard (Tab, or an arrow key outside a text field), and go away at the next
// pointer press. `html[data-focus-ring]` is what styles/focus-ring.css keys on.

const NAVIGATION_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

const isTextField = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit'].includes((target as HTMLInputElement).type)));

/** Whether a key press is the user moving focus around, rather than typing or a shortcut. Pure. */
export function movesFocus(key: string, modified: boolean, inTextField: boolean): boolean {
  if (!NAVIGATION_KEYS.has(key)) return false;
  if (key === 'Tab') return true;
  return !modified && !inTextField;
}

/** Installs the listeners once, for the page's life. */
export function installFocusRing(root: HTMLElement = document.documentElement): void {
  const set = (on: boolean) => (on ? root.setAttribute('data-focus-ring', '') : root.removeAttribute('data-focus-ring'));
  window.addEventListener('keydown', (e) => movesFocus(e.key, e.metaKey || e.ctrlKey || e.altKey, isTextField(e.target)) && set(true), true);
  window.addEventListener('pointerdown', () => set(false), true);
}
