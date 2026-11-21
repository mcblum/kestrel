// The top line of the Terminal view: the scope's terminals as tabs while there are few
// (MAX_TERMINAL_TABS), or one menu button when there are more (a tab row cannot scroll sideways
// usefully). Either way the + to open a terminal and the pane's X stay at the same spots. Tabs and
// menu rows can be dragged into a new order, can be renamed by double-click, and closed.
import { memo, useState, type DragEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { terminalStripMode } from '@kestrel/server/terminals';
import type { TerminalInfo } from '../terminalStore.ts';
import { PaneClose } from './PaneHead.tsx';
import { TerminalMenu } from './TerminalMenu.tsx';
import { dragTerminal, exitedTip, RenameField, TERMINAL_MIME, type StripProps } from './terminalParts.tsx';

export type { StripProps };

export function TerminalStrip(props: StripProps) {
  const { onNew, newTip, actions } = props;
  const mode = terminalStripMode(props.list.length);
  return (
    <div className="term-bar">
      {mode === 'tabs' ? <TerminalTabs {...props} /> : <TerminalMenu {...props} />}
      {actions}
      <button type="button" className="term-tab-new" aria-label="New terminal" title={newTip} onClick={onNew}>
        <Plus aria-hidden />
      </button>
      <PaneClose pane="terminal" name="Terminal" />
    </div>
  );
}

function TerminalTabs({ list, active, onChoose, onClose, onRename, onMove }: StripProps) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <div className="term-tabs" role="tablist" aria-label="Terminals">
      {list.map((t) => (
        <TerminalTab
          key={t.id}
          info={t}
          active={t.id === active}
          editing={editing === t.id}
          onChoose={onChoose}
          onClose={onClose}
          onEdit={setEditing}
          onMove={onMove}
          onRename={(title) => (setEditing(null), title !== null && onRename(t.id, title))}
        />
      ))}
    </div>
  );
}

type Side = 'before' | 'after' | null;

/** The right half of a tab means "after it". */
const rightHalf = (event: DragEvent) => {
  const box = event.currentTarget.getBoundingClientRect();
  return event.clientX > box.left + box.width / 2;
};

/** A tab that dragged tabs land beside: the drop line shows on its left or right edge. */
function useTabDrop(id: string, onMove: StripProps['onMove']) {
  const [side, setSide] = useState<Side>(null);
  const carries = (event: DragEvent) => event.dataTransfer.types.includes(TERMINAL_MIME);
  return {
    side,
    props: {
      onDragOver: (event: DragEvent) => {
        if (!carries(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setSide(rightHalf(event) ? 'after' : 'before');
      },
      onDragLeave: (event: DragEvent) => !event.currentTarget.contains(event.relatedTarget as Node | null) && setSide(null),
      onDrop: (event: DragEvent) => {
        setSide(null);
        const moving = carries(event) ? event.dataTransfer.getData(TERMINAL_MIME) : '';
        if (!moving) return;
        event.preventDefault();
        if (moving !== id) onMove(moving, id, rightHalf(event));
      },
    },
  };
}

interface TabProps {
  info: TerminalInfo;
  active: boolean;
  editing: boolean;
  onChoose: (id: string) => void;
  onClose: (t: TerminalInfo) => void;
  onEdit: (id: string) => void;
  onMove: StripProps['onMove'];
  /** The new name, or null when the edit was abandoned. */
  onRename: (title: string | null) => void;
}

const TerminalTab = memo(function TerminalTab({ info, active, editing, onChoose, onClose, onEdit, onMove, onRename }: TabProps) {
  const drop = useTabDrop(info.id, onMove);
  const className = `term-tab${active ? ' active' : ''}${info.exited ? ' exited' : ''}${drop.side ? ` drop-${drop.side}` : ''}`;
  return (
    <div className={className} draggable={!editing} onDragStart={dragTerminal(info.id)} {...drop.props} onAuxClick={(e) => e.button === 1 && onClose(info)}>
      {editing ? (
        <RenameField title={info.title} onDone={onRename} />
      ) : (
        <button
          type="button"
          role="tab"
          aria-selected={active}
          className="term-tab-main"
          title={exitedTip(info) ?? info.title}
          onClick={() => onChoose(info.id)}
          onDoubleClick={() => onEdit(info.id)}
        >
          <span className="term-tab-title">{info.title}</span>
        </button>
      )}
      <button type="button" className="term-tab-close" aria-label={`Close ${info.title}`} onClick={() => onClose(info)}>
        <X aria-hidden />
      </button>
    </div>
  );
});
