// The terminal strip when there are more terminals than fit as tabs: one button naming the current
// terminal and its place ("zsh · 2 of 5"), opening a menu of every terminal. The menu looks and
// closes like the app's other menus (the context menu's panel and rows; Escape or a click outside
// closes it and gives focus back to the button). Each row selects its terminal, is renamed with its
// pencil and closed with its X, and can be dragged above or below another row. Keys: Enter or
// Space opens, arrows move, Enter chooses, Escape closes.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, Pencil, Plus, X } from 'lucide-react';
import { terminalMenuLabel } from '@kestrel/server/terminals';
import type { TerminalInfo } from '../terminalStore.ts';
import { Popup } from './Popup.tsx';
import { useEdgeTarget } from './sidebarDrag.ts';
import { dragTerminal, exitedTip, RenameField, TERMINAL_MIME, type StripProps } from './terminalParts.tsx';

/** Close on a press outside `host`; Escape is handled by the menu's own keys. */
function useOutside(open: boolean, host: React.RefObject<HTMLElement | null>, close: () => void) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !host.current?.contains(e.target as Node) && latest.current();
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open, host]);
}

export function TerminalMenu({ list, active, onChoose, onClose, onNew, onRename, onMove }: StripProps) {
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  // The rows a key can reach: every terminal, then New terminal.
  const count = list.length + 1;
  const current = list.find((t) => t.id === active);

  const close = (refocus: boolean) => {
    setOpen(false);
    setEditing(null);
    if (refocus) button.current?.focus();
  };
  useOutside(open, host, () => close(false));
  useEffect(() => {
    if (open && !editing) rows.current[focus]?.focus();
  }, [open, focus, editing]);

  const openMenu = () => {
    setFocus(Math.max(0, list.findIndex((t) => t.id === active)));
    setOpen(true);
  };
  const choose = (id: string) => (onChoose(id), close(true));
  const onKeys = (e: KeyboardEvent) => {
    if (editing) return;
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (step) setFocus((f) => (f + step + count) % count);
    else if (e.key === 'Escape') close(true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="picker term-menu" ref={host}>
      <button
        ref={button}
        type="button"
        className={`term-menu-button${current?.exited ? ' exited' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={current ? (exitedTip(current) ?? current.title) : undefined}
        onClick={() => (open ? close(true) : openMenu())}
      >
        <span className="term-tab-title">{terminalMenuLabel(list, active)}</span>
        <ChevronDown aria-hidden />
      </button>
      {open && (
        <Popup anchor={button} side="below" className="context-menu term-menu-pop" role="menu" aria-label="Terminals" onKeyDown={onKeys}>
          {list.map((t, i) => (
            <MenuRow
              key={t.id}
              info={t}
              current={t.id === active}
              editing={editing === t.id}
              focused={focus === i}
              rowRef={(el) => void (rows.current[i] = el)}
              onFocus={() => setFocus(i)}
              onChoose={() => choose(t.id)}
              onClose={() => onClose(t)}
              onEdit={() => setEditing(t.id)}
              onRename={(title) => (setEditing(null), title !== null && onRename(t.id, title))}
              onMove={onMove}
            />
          ))}
          <div className="menu-sep" role="separator" />
          <button ref={(el) => void (rows.current[list.length] = el)} type="button" role="menuitem" className="menu-item" tabIndex={focus === list.length ? 0 : -1} onMouseEnter={() => setFocus(list.length)} onClick={() => (onNew(), close(true))}>
            <Plus aria-hidden />
            <span>New terminal</span>
          </button>
        </Popup>
      )}
    </div>
  );
}

interface RowProps {
  info: TerminalInfo;
  current: boolean;
  editing: boolean;
  focused: boolean;
  rowRef: (el: HTMLButtonElement | null) => void;
  onFocus: () => void;
  onChoose: () => void;
  onClose: () => void;
  onEdit: () => void;
  onRename: (title: string | null) => void;
  onMove: StripProps['onMove'];
}

function MenuRow({ info, current, editing, focused, rowRef, onFocus, onChoose, onClose, onEdit, onRename, onMove }: RowProps) {
  const drop = useEdgeTarget(
    (event) => event.dataTransfer.types.includes(TERMINAL_MIME),
    (event, after) => {
      const moving = event.dataTransfer.getData(TERMINAL_MIME);
      if (moving && moving !== info.id) onMove(moving, info.id, after);
    },
  );
  return (
    <div className={`menu-slot term-menu-row${info.exited ? ' exited' : ''}${drop.edge ? ` drop-${drop.edge}` : ''}`} draggable={!editing} onDragStart={dragTerminal(info.id)} {...drop.props}>
      {editing ? (
        <RenameField title={info.title} onDone={onRename} />
      ) : (
        <button
          ref={rowRef}
          type="button"
          role="menuitemradio"
          aria-checked={current}
          className="menu-item"
          tabIndex={focused ? 0 : -1}
          title={exitedTip(info)}
          onMouseEnter={onFocus}
          onClick={onChoose}
        >
          {current ? <Check aria-hidden /> : <span className="term-menu-mark" aria-hidden />}
          <span className="term-tab-title">{info.title}</span>
        </button>
      )}
      {!editing && (
        <button type="button" className="term-tab-close" aria-label={`Rename ${info.title}`} onClick={onEdit}>
          <Pencil aria-hidden />
        </button>
      )}
      <button type="button" className="term-tab-close" aria-label={`Close ${info.title}`} onClick={onClose}>
        <X aria-hidden />
      </button>
    </div>
  );
}
