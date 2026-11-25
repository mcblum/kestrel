// An in-page context menu (not the OS one, so it behaves the same in a browser and in Electron).
// Opens where it was asked for, closes on Escape or an outside click, and is keyboard navigable.
// Items may carry a tick, a switch, a shortcut key (pressed while the menu is open) and a current
// value beside a submenu's arrow (shared/menu.ts); a menu opened with `onPick` reports picks to
// its opener instead of running app actions (menuState.ts). The menu and each submenu are kept
// inside the window (usePopupPlacement): a submenu opens to the right of its menu, or to the left
// when there is no room, level with its item and shifted up or down to stay inside.
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Check, ChevronRight } from 'lucide-react';
import { REVEAL_ID, type MenuItem } from '@kestrel/server/menu';
import type { Side } from '@kestrel/server/popup-place';
import { runMenuAction } from '../commands.ts';
import { showInManager } from '../platform.ts';
import { wantsNewTab } from '../route.ts';
import { contextMenu, useContextMenu, type OpenMenu } from '../menuState.ts';
import { usePopupPlacement } from './usePopupPlacement.ts';

/** Space between a menu and its submenu, and the menu's padding (a submenu's first item sits level with its parent item). */
const SUBMENU_GAP = 2;
const MENU_PADDING = 4;

interface ListProps {
  items: MenuItem[];
  menu: OpenMenu;
  depth?: number;
  /** The side this list opened on, read when a submenu opens: a submenu keeps going the same way. */
  side?: RefObject<{ side: Side } | null>;
}

interface SubmenuProps {
  item: MenuItem;
  menu: OpenMenu;
  depth: number;
  /** The parent's row button, and the side the parent opened on. */
  row: HTMLButtonElement | null;
  parentSide?: RefObject<{ side: Side } | null>;
}

/** A submenu beside its parent menu, level with its item; fixed, so a scrolling parent does not clip it. */
function Submenu({ item, menu, depth, row, parentSide }: SubmenuProps) {
  const box = useRef<HTMLDivElement>(null);
  const placed = usePopupPlacement(
    box,
    () => {
      const parent = row?.closest('.context-menu');
      if (!row || !parent) return null;
      const r = row.getBoundingClientRect();
      const p = parent.getBoundingClientRect();
      const side: Side = parentSide?.current?.side === 'left' ? 'left' : 'right';
      return { anchor: { left: p.left, right: p.right, top: r.top - MENU_PADDING, bottom: r.bottom + MENU_PADDING }, side, align: menu.above ? 'end' : 'start', gap: SUBMENU_GAP };
    },
    [row, menu.above],
  );
  return (
    <div ref={box} className="submenu">
      <MenuList items={item.children!} menu={menu} depth={depth + 1} side={placed} />
    </div>
  );
}

/** `ticks`: some item of this list can carry a tick, so every row keeps a column for it. */
function ItemBody({ item, ticks }: { item: MenuItem; ticks: boolean }) {
  return (
    <>
      {ticks && !item.toggle && <span className="menu-tick">{item.checked && <Check aria-hidden />}</span>}
      {/* An app's own icon (the Open in menu). Decorative: the label names it. */}
      {item.icon && <img className="menu-icon" src={item.icon} alt="" aria-hidden />}
      {/* Menus are worded for a Mac where they are built; the file manager's name is this computer's. */}
      <span>{item.id === REVEAL_ID ? showInManager() : item.label}</span>
      {item.hint && <small>{item.hint}</small>}
      {item.value && <small className="menu-value">{item.value}</small>}
      {item.shortcut && <kbd className="menu-key">{item.shortcut}</kbd>}
      {item.toggle && <span className={`menu-switch${item.checked ? ' on' : ''}`} aria-hidden />}
      {item.children && <ChevronRight aria-hidden />}
    </>
  );
}

function MenuList({ items, menu, depth = 0, side }: ListProps) {
  const [focus, setFocus] = useState(0);
  const [openChild, setOpenChild] = useState<string | null>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
  const hasTicks = items.some((it) => it.checked !== undefined && !it.toggle);

  useEffect(() => {
    refs.current[focus]?.focus();
  }, [focus]);

  const move = (delta: number) => {
    if (enabled.length === 0) return;
    const at = enabled.indexOf(focus);
    setFocus(enabled[(at + delta + enabled.length) % enabled.length]!);
  };
  const activate = (item: MenuItem, newTab = false) => {
    if (item.disabled) return;
    if (item.children) return setOpenChild(item.id);
    if (menu.onPick) {
      // A switch flips in place; the opener replaces the items. Anything else is a choice: close.
      if (!item.toggle) contextMenu.close();
      return menu.onPick(item);
    }
    if (!item.action) return;
    contextMenu.close();
    void runMenuAction(item.action, newTab);
  };

  return (
    <div
      className={`context-menu${menu.width ? ' context-menu-fixed' : ''}`}
      style={menu.width ? { width: menu.width } : undefined}
      role="menu"
      onKeyDown={(e) => {
        const keyed = !e.metaKey && !e.ctrlKey && !e.altKey ? items.find((it) => it.shortcut === e.key && !it.disabled) : undefined;
        if (keyed) (e.preventDefault(), e.stopPropagation(), activate(keyed));
        else if (e.key === 'ArrowDown') (e.preventDefault(), e.stopPropagation(), move(1));
        else if (e.key === 'ArrowUp') (e.preventDefault(), e.stopPropagation(), move(-1));
        else if (e.key === 'ArrowRight' && items[focus]?.children) (e.preventDefault(), e.stopPropagation(), setOpenChild(items[focus]!.id));
        else if (e.key === 'ArrowLeft' && depth > 0) (e.preventDefault(), e.stopPropagation(), setOpenChild(null), void 0);
      }}
    >
      {items.map((item, i) => (
        <div key={item.id} className="menu-slot">
          {item.separatorBefore && <div className="menu-sep" role="separator" />}
          {item.heading && <div className="menu-heading">{item.heading}</div>}
          <button
            ref={(el) => void (refs.current[i] = el)}
            role={item.toggle ? 'menuitemcheckbox' : item.checked !== undefined ? 'menuitemradio' : 'menuitem'}
            className={`menu-item${item.disabled ? ' disabled' : ''}`}
            aria-disabled={item.disabled || undefined}
            aria-checked={item.checked === undefined ? undefined : item.checked}
            aria-haspopup={item.children ? 'menu' : undefined}
            aria-expanded={item.children ? openChild === item.id : undefined}
            aria-keyshortcuts={item.shortcut}
            tabIndex={i === focus ? 0 : -1}
            onMouseEnter={() => {
              if (!item.disabled) setFocus(i);
              setOpenChild(item.children && !item.disabled ? item.id : null);
            }}
            onClick={(e) => activate(item, wantsNewTab(e))}
          >
            <ItemBody item={item} ticks={hasTicks} />
          </button>
          {item.children && openChild === item.id && <Submenu item={item} menu={menu} depth={depth} row={refs.current[i] ?? null} parentSide={side} />}
        </div>
      ))}
    </div>
  );
}

export function ContextMenuHost() {
  const menu = useContextMenu();
  const box = useRef<HTMLDivElement>(null);
  // At the click, or from the button that opened it (above it with `above`), wherever it fits.
  const placed = usePopupPlacement(box, () => menu && { anchor: menu.anchor, side: menu.beside ? 'right' : menu.above ? 'above' : 'below', align: 'start', gap: menu.gap ?? 0 }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = () => contextMenu.close();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    const outside = (e: Event) => !box.current?.contains(e.target as Node) && close();
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', outside);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', outside);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, [menu]);

  if (!menu) return null;
  return (
    <div ref={box} className="context-menu-host">
      <MenuList items={menu.items} menu={menu} side={placed} />
    </div>
  );
}
