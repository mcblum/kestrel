// The app's one drag-and-drop mechanism for reordering, shared by every list in the sidebar
// (Pinned, Sessions, Projects) and by the composer's attachments. A row carries its own kind
// (session, group, project, attachment) as the drag's type; a target shows a drop line on its top
// or bottom edge (left or right for a row of tiles), whichever half the pointer is in.
import { createContext, useEffect, useState, type DragEvent } from 'react';
import { GROUP_MIME, PROJECT_MIME, REVIEW_MIME, SESSION_MIME } from '../labels.ts';
import type { PinKind } from '@kestrel/server/model';

export type Edge = 'before' | 'after' | null;

/** Where a dragged row should land relative to the row under the pointer. */
export const lowerHalf = (event: DragEvent) => {
  const box = event.currentTarget.getBoundingClientRect();
  return event.clientY > box.top + box.height / 2;
};

/** The same across a row of tiles: the right half means after. */
export const rightHalf = (event: DragEvent) => {
  const box = event.currentTarget.getBoundingClientRect();
  return event.clientX > box.left + box.width / 2;
};

/** Which way a list runs: down (rows) or across (tiles). */
export type Axis = 'y' | 'x';
const pastHalf = (event: DragEvent, axis: Axis) => (axis === 'x' ? rightHalf(event) : lowerHalf(event));

/** Is a row of this kind being dragged? */
export const carries = (event: DragEvent, mime: string) => event.dataTransfer.types.includes(mime);

/**
 * The row being dragged right now. A drop target cannot read the drag's data until the drop, but
 * some must decide earlier whether to show anything: a list sorted by most recent takes no drop of
 * a session already in it (it would land where it was).
 */
let dragging: { mime: string; id: string } | null = null;

/**
 * Every drop highlight (a drop line, a lit group or list) is cleared here when a drag ends, not by
 * each target: a target that stops a drop's propagation (a row, a group's top edge) keeps the
 * targets around it from seeing the drop, and no dragleave follows a drop, so their highlight
 * would stay on. Listening on the window in the capture phase sees every drop and dragend before
 * any target can stop it. A dragend fired on a row that was removed mid-drag reaches no listener;
 * the next pointer move (none are sent during a drag) or the next drag start clears it then.
 */
const clearers = new Set<() => void>();
let lit = false;

export function endDragHighlights(): void {
  if (!lit) return;
  lit = false;
  for (const clear of clearers) clear();
}

if (typeof window !== 'undefined') {
  const ended = () => {
    endDragHighlights();
    // Drop handlers still read the dragged row: forget it once this event has been handled.
    setTimeout(() => void (dragging = null), 0);
  };
  for (const type of ['drop', 'dragend']) window.addEventListener(type, ended, true);
  for (const type of ['dragstart', 'pointermove']) window.addEventListener(type, endDragHighlights, true);
}

/** A drop target's highlight state, `off` when no drag is over it; it never outlives the drag. */
export function useDragHighlight<T>(off: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(off);
  useEffect(() => {
    const clear = () => setValue(off);
    clearers.add(clear);
    return () => void clearers.delete(clear);
  }, [off]);
  const set = (next: T) => {
    if (next !== off) lit = true;
    setValue(next);
  };
  return [value, set];
}

/** The id of the row of this kind being dragged, if one is. */
export const draggingId = (mime: string): string | null => (dragging?.mime === mime ? dragging.id : null);

/** Start dragging a row of one kind; sessions, groups and projects each carry their own type. */
export const startDrag = (mime: string, id: string) => (event: DragEvent) => {
  dragging = { mime, id };
  event.dataTransfer.setData(mime, id);
  event.dataTransfer.effectAllowed = 'move';
  event.stopPropagation();
};

/** The drag types, by the kind of pin each one is. */
const MIME_OF: Record<PinKind, string> = { session: SESSION_MIME, group: GROUP_MIME, project: PROJECT_MIME, review: REVIEW_MIME };
const KINDS = Object.keys(MIME_OF) as PinKind[];

/** Which kind of row is being dragged, if it is one of the three. */
export const draggedKind = (event: DragEvent): PinKind | null => KINDS.find((kind) => carries(event, MIME_OF[kind])) ?? null;

/** The row being dragged, while the drag is on (before the drop can read its data); null for a drag from outside the sidebar. */
export function draggingItem(event: DragEvent): { kind: PinKind; id: string } | null {
  const kind = draggedKind(event);
  const id = kind && draggingId(MIME_OF[kind]);
  return kind && id ? { kind, id } : null;
}

/** The dragged row's kind and id, read on drop. */
export function droppedItem(event: DragEvent): { kind: PinKind; id: string } | null {
  const kind = draggedKind(event);
  const id = kind && event.dataTransfer.getData(MIME_OF[kind]);
  return kind && id ? { kind, id } : null;
}

/**
 * A block that dragged rows can be dropped beside: the drop line shows on its top or bottom edge.
 * `accepts` says which drags it takes; any other drag passes through untouched.
 */
export function useEdgeTarget(accepts: (event: DragEvent) => boolean, onDrop: (event: DragEvent, after: boolean) => void, axis: Axis = 'y') {
  const [edge, setEdge] = useDragHighlight<Edge>(null);
  return {
    edge,
    props: {
      onDragOver: (event: DragEvent) => {
        if (!accepts(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        setEdge(pastHalf(event, axis) ? 'after' : 'before');
      },
      onDragLeave: (event: DragEvent) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setEdge(null);
      },
      onDrop: (event: DragEvent) => {
        if (!accepts(event)) return;
        setEdge(null);
        event.preventDefault();
        event.stopPropagation();
        onDrop(event, pastHalf(event, axis));
      },
    },
  };
}

/** A block that rows of one kind (`mime`) can be dropped beside, as `useEdgeTarget`. */
export function useReorderTarget(mime: string, onDrop: (id: string, after: boolean) => void, axis: Axis = 'y') {
  return useEdgeTarget(
    (event) => carries(event, mime),
    (event, after) => {
      const id = event.dataTransfer.getData(mime);
      if (id) onDrop(id, after);
    },
    axis,
  );
}

/**
 * True inside the PINNED section. Rows there still start drags of their own kind, but take no
 * drops themselves: the pinned row around them does, so every drop there places a pin.
 */
export const InPinned = createContext(false);

/**
 * True in the CODE REVIEWS section. A review session's row there is its own row (not a reference),
 * but the section's order follows the requests, so its rows take no drops and show no drop line.
 */
export const InReviews = createContext(false);

/**
 * True in the session list under an expanded tag. That order is derived (the tag page's), so its
 * rows take no drops and show no drop line; they still drag out to a group, project or PINNED.
 */
export const InTag = createContext(false);

/**
 * True in the list under an open workstream. Its rows are references to sessions that live in
 * projects, so each one says which project it is in.
 */
export const InWorkstream = createContext(false);
