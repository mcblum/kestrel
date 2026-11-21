// The Archive button laid over the right end of a session row, shown on hover or keyboard focus in
// place of the row's dot and icons (sidebar-rows.css). One click archives the session at once,
// with the same action as the row menu's Archive; it is brought back from Settings → Archived.
// Offered only when that menu item is enabled (shared/row-slot.ts: offersArchive). It sits beside
// the row's button, not in it, so it neither opens the session nor starts dragging the row.
import type { DragEvent, MouseEvent } from 'react';
import { Archive } from 'lucide-react';
import { archiveLabel } from '@kestrel/server/row-slot';
import { runMenuAction } from '../commands.ts';

/** Pressing it must never start dragging anything. */
const noDrag = (event: DragEvent) => (event.preventDefault(), event.stopPropagation());

export function RowArchive({ sessionId, title }: { sessionId: string; title: string }) {
  const label = archiveLabel(title);
  const archive = (event: MouseEvent) => {
    event.stopPropagation();
    void runMenuAction({ type: 'archive', kind: 'session', id: sessionId }, false);
  };
  return (
    <button type="button" className="icon-button row-more row-archive" aria-label={label} title={label} draggable={false} onDragStart={noDrag} onClick={archive} data-menu-kind="session" data-menu-id={sessionId}>
      <Archive aria-hidden />
    </button>
  );
}
