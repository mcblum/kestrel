// Pieces the terminal tabs and the terminal menu share: what they are given, how a terminal is
// dragged, the tooltip of an exited one, and the in-place rename box.
import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import type { TerminalInfo } from '../terminalStore.ts';

/** A terminal tab or menu row being dragged to a new place. */
export const TERMINAL_MIME = 'application/x-kestrel-terminal';

export interface StripProps {
  list: readonly TerminalInfo[];
  active: string | null;
  onChoose: (id: string) => void;
  onClose: (t: TerminalInfo) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  /** Put terminal `id` before (or after) terminal `target`. */
  onMove: (id: string, target: string, after: boolean) => void;
  /** The + button's tooltip. */
  newTip: string;
  /** The project's saved actions menu, when the scope has a project (TerminalActions.tsx). */
  actions?: ReactNode;
}

/** Start dragging a terminal tab or menu row. */
export const dragTerminal = (id: string) => (event: DragEvent) => {
  event.dataTransfer.setData(TERMINAL_MIME, id);
  event.dataTransfer.effectAllowed = 'move';
};

/** What an exited terminal's tab or row says when pointed at. */
export const exitedTip = (info: TerminalInfo): string | undefined => (info.exited ? `${info.title} (exited${info.exitCode ? ` with code ${info.exitCode}` : ''})` : undefined);

/** A terminal's name, edited where it stands. Enter or leaving keeps it; Escape puts it back. */
export function RenameField({ title, onDone }: { title: string; onDone: (title: string | null) => void }) {
  const [value, setValue] = useState(title);
  const done = useRef(false);
  const finish = (result: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(result);
  };
  return (
    <input
      className="term-tab-rename"
      aria-label="Terminal name"
      value={value}
      size={Math.max(4, value.length + 1)}
      maxLength={60}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value.trim() === title ? null : value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(value.trim() === title ? null : value);
        else if (e.key === 'Escape') finish(null);
      }}
    />
  );
}
