// The sidebar's PINNED section: sessions, projects and groups the user pinned, in the session order
// chosen in Settings: the order the user dragged them into, or newest activity first
// (shared/pinned-order.ts; the Sidebar passes the rows already ordered). A pinned item has left its
// usual place (shared/pinned-homes.ts) and is drawn here exactly as it is drawn there: a session row
// with what hangs under it, a group with its sessions, a project with its list. The rows themselves
// come from the Sidebar (`render`).
//
// Drag and drop, with the sidebar's one mechanism (sidebarDrag.ts). Custom order: drop any row
// (pinned or not, session, group or project) above or below a pinned row to put it there; an
// unpinned row dropped here gets pinned. Most recent first: a place in the list means nothing, so
// rows show no drop line and a pinned row dragged within PINNED goes nowhere; an unpinned row
// dropped anywhere on the list gets pinned (the whole list lights up), and the dragged order is
// left as it was for when the user goes back to a custom order. Dragging a pinned row into the
// Sessions or Projects list unpins it (Sidebar.tsx). While nothing is pinned the section is not drawn.
import type { DragEvent, ReactNode } from 'react';
import type { PinnedRow } from '@kestrel/server/pinned-homes';
import { isPinned, pinKey } from '@kestrel/server/pins';
import { actions, appStore } from '../store.ts';
import { useSessionOrder } from '../tabsStore.ts';
import { Heading, useSectionOpen } from './SidebarHeading.tsx';
import { draggedKind, draggingItem, droppedItem, InPinned, useEdgeTarget } from './sidebarDrag.ts';

const takesDrag = (event: DragEvent) => draggedKind(event) !== null;

/** Is this row already under PINNED? A drag from outside the sidebar is not known: not pinned. */
const alreadyPinned = (item: { kind: PinnedRow['kind']; id: string } | null): boolean => {
  const ws = appStore.get().workspace;
  return !!item && !!ws && isPinned(ws.pins, item.kind, item.id);
};

function PinSlot({ row, reorders, children }: { row: PinnedRow; reorders: boolean; children: ReactNode }) {
  const target = useEdgeTarget(
    (event) => reorders && takesDrag(event),
    (event, after) => {
      const item = droppedItem(event);
      if (item && pinKey(item) !== pinKey(row)) void actions.placePin(item, { kind: row.kind, id: row.id }, after);
    },
  );
  return (
    <div className={`pin-slot${target.edge ? ` drop-${target.edge}` : ''}`} {...target.props}>
      {children}
    </div>
  );
}

/** `kept`: drawn below the folded heading: the open session's row when it is under PINNED. */
export function SidebarPins({ rows, render, kept }: { rows: readonly PinnedRow[]; render: (row: PinnedRow) => ReactNode; kept?: ReactNode }) {
  const open = useSectionOpen('pinned');
  const reorders = useSessionOrder() === 'custom';
  // Custom order: a drop in the gap after the last row goes to the end of the list. Most recent:
  // the list takes rows that are not pinned yet, wherever they are dropped on it.
  const end = useEdgeTarget(
    (event) => takesDrag(event) && (reorders || !alreadyPinned(draggingItem(event))),
    (event) => {
      const item = droppedItem(event);
      if (item && (reorders || !alreadyPinned(item))) void actions.placePin(item, null, true);
    },
  );
  // Nothing pinned: the section is not drawn, during a drag too, so the rows below never jump.
  if (rows.length === 0) return null;
  return (
    <>
      <Heading title="PINNED" id="pinned" menuKind="pinned" />
      {!open && kept}
      {open && (
        <InPinned.Provider value>
          <div className={`pin-list${!reorders && end.edge ? ' drop-over' : ''}`} {...end.props}>
            {rows.map((row) => (
              <PinSlot key={pinKey(row)} row={row} reorders={reorders}>
                {render(row)}
              </PinSlot>
            ))}
          </div>
        </InPinned.Provider>
      )}
    </>
  );
}
