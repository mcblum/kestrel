// What every container row in the sidebar (group, project, tag) shares, so they cannot drift:
// - `foldClick`: a click anywhere on the row's name folds its list open or shut; Shift or Cmd-click,
//   or a middle click, opens the container's page in a new tab instead. The page itself is reached
//   from the row's menu ("Open … page").
// - `FoldChevron`: the chevron after the name, which only shows the state (it is not a button).
// - `RowOpen`: the arrow shown on hover or focus left of the …, which opens the container's page
//   (in a new tab with Shift or Cmd, as everywhere).
// - `RowMore`: the … shown on hover or focus just left of the + (or at the far right where there is
//   no +), which opens the same menu as a right-click on the row, under the button.
import type { DragEvent, MouseEvent } from 'react';
import { ArrowUpRight, ChevronDown, ChevronRight, Ellipsis } from 'lucide-react';
import { openView, wantsNewTab, type View } from '../route.ts';
import { openRowMenu, type RowKind } from './sidebarMenuTarget.ts';

/** The click handlers of a container row's name: fold it, or open its page in a new tab. */
export function foldClick(view: View, toggle: () => void) {
  return {
    onClick: (event: MouseEvent) => (wantsNewTab(event) ? openView(view, true) : toggle()),
    onAuxClick: (event: MouseEvent) => event.button === 1 && (event.preventDefault(), openView(view, true)),
  };
}

export function FoldChevron({ open }: { open: boolean }) {
  return open ? <ChevronDown className="fold-chevron" aria-hidden /> : <ChevronRight className="fold-chevron" aria-hidden />;
}

/** A button inside a draggable row: pressing it must never start dragging the row. */
const noDrag = (event: DragEvent) => (event.preventDefault(), event.stopPropagation());

/** Below the button, its left edge level with the button's. */
const MENU_GAP = 2;

/** Opens the page of the row's group, project, tag or workstream: the one thing a click on the name (which folds) does not do. */
export function RowOpen({ view, name, what }: { view: View; name: string; what: 'group' | 'project' | 'tag' | 'workstream' }) {
  const label = `Open the ${name} ${what} page`;
  return (
    <button
      type="button"
      className="icon-button row-more row-open"
      aria-label={label}
      title={label}
      draggable={false}
      onDragStart={noDrag}
      onClick={(event) => {
        event.stopPropagation();
        openView(view, wantsNewTab(event));
      }}
    >
      <ArrowUpRight aria-hidden />
    </button>
  );
}

export function RowMore({ kind, id, name }: { kind: RowKind; id: string; name: string }) {
  const label = `More for ${name}`;
  return (
    <button
      type="button"
      className="icon-button row-more"
      aria-label={label}
      title={label}
      aria-haspopup="menu"
      draggable={false}
      onDragStart={noDrag}
      onClick={(event) => {
        event.stopPropagation();
        openRowMenu(kind, id, { from: event.currentTarget, gap: MENU_GAP });
      }}
    >
      <Ellipsis aria-hidden />
    </button>
  );
}
