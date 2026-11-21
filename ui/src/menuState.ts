// Which context menu is open. One at a time; opened from the sidebar or a control, closed by Escape or any click.
import { useSyncExternalStore } from 'react';
import type { MenuItem } from '@kestrel/server/menu';
import { pointRect, type Rect } from '@kestrel/server/popup-place';

export interface MenuOptions {
  /**
   * Picks go here instead of to the app's menu actions (commands.ts): for a menu that changes
   * something local, such as the controls under the message box. Gets the picked item.
   */
  onPick?: (item: MenuItem) => void;
  /** Prefer opening upward, above the anchor; submenus then line up by their bottom edge. */
  above?: boolean;
  /** Where focus goes back to when the menu closes (the button that opened it). */
  returnFocus?: HTMLElement | null;
  /** Space between the button and the menu (openFrom). */
  gap?: number;
  /**
   * Open to the right of the anchor, its top level with the anchor's top and moved only as far as
   * the window needs: where a hover card sat beside the sidebar (openBeside).
   */
  beside?: boolean;
}

export interface OpenMenu extends MenuOptions {
  /** What the menu hangs from: the pressed button, or the point of a right-click. */
  anchor: Rect;
  items: MenuItem[];
}

/** Space between a button and the menu it opens, unless the opener says otherwise. */
const BUTTON_GAP = 4;

let current: OpenMenu | null = null;
const listeners = new Set<() => void>();
const set = (next: OpenMenu | null) => {
  const closing = current && !next ? current : null;
  current = next;
  listeners.forEach((l) => l());
  closing?.returnFocus?.focus();
};

export const contextMenu = {
  /** At a point (a right-click): down and to the right of it, or wherever it fits. */
  open: (x: number, y: number, items: MenuItem[], options: MenuOptions = {}) => set({ ...options, anchor: pointRect(x, y), gap: 0, items }),
  /** From a button: under it (above with `above`) lined up with its left edge, or wherever it fits. */
  openFrom: (button: Element, items: MenuItem[], options: MenuOptions = {}) => {
    const r = button.getBoundingClientRect();
    set({ gap: BUTTON_GAP, ...options, anchor: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, items });
  },
  /** Beside something (a sidebar row's hover card): to its right, top-aligned, kept inside the window. */
  openBeside: (anchor: Rect, items: MenuItem[], options: MenuOptions = {}) => set({ gap: BUTTON_GAP, ...options, beside: true, anchor, items }),
  /** The open menu with new items, where it is (a switch flipped inside it). */
  replace: (items: MenuItem[]) => current && set({ ...current, items }),
  close: () => current && set(null),
  /** The menu open now, if any: a button that opens one checks it on press, to close it instead. */
  current: (): OpenMenu | null => current,
};

export const useContextMenu = () => useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => current);
