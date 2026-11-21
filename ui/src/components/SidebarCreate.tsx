// Starting a session in a sidebar container: the + that shows at the far right of a project or
// group row on hover or focus, and the "Create a session…" row an empty list shows. Both run the
// container's own "New session" menu item (menu.ts), so the menu, the + and the row cannot disagree.
import type { DragEvent } from 'react';
import { Plus } from 'lucide-react';
import { ALL_PINNED_LABEL, CREATE_SESSION_LABEL, type EmptyListKind } from '@kestrel/server/pinned-homes';
import { item } from '@kestrel/server/menu';
import { runMenuAction } from '../commands.ts';
import { opener } from '../route.ts';

/** A project, a group, or (empty) the Sessions list: where the new session is filed. */
export type Container = { projectId?: string; groupId?: string };

const startIn = (container: Container) => opener((newTab) => void runMenuAction(item.newSession(container).action!, newTab));
/** The + sits inside draggable rows: pressing it must never start dragging the row. */
const noDrag = (event: DragEvent) => (event.preventDefault(), event.stopPropagation());

/** The + at a row's far right; it takes the place of the row's dot while shown. */
export function RowPlus({ container, name }: { container: Container; name: string }) {
  const label = `New session in ${name}`;
  return (
    <button type="button" className="icon-button row-plus" aria-label={label} title={label} draggable={false} onDragStart={noDrag} {...startIn(container)}>
      <Plus aria-hidden />
    </button>
  );
}

/** What an empty list draws in place of its rows: a row that creates a session there, or a note. */
export function EmptyList({ kind, container, className = 'tree-empty' }: { kind: EmptyListKind | null; container: Container; className?: string }) {
  if (kind === null) return null;
  if (kind === 'all-pinned') return <div className={className}>{ALL_PINNED_LABEL}</div>;
  return (
    <button type="button" className={`${className} create-row`} {...startIn(container)}>
      <Plus aria-hidden />
      <span>{CREATE_SESSION_LABEL}</span>
    </button>
  );
}
