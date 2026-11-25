// The Changes pane's two regions: the file list above, the diff below, each scrolling on its own,
// with a bar between them that is dragged (or moved with the arrow keys) to resize. The height is
// kept with the other pane sizes (tabsStore `setChangesListHeight`); the limits are changes-split.ts.
// The regions arrive as elements, so dragging the bar or the pane changing size re-renders only this
// frame, never the diff.
import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { CHANGES_LIST_HEIGHT, CHANGES_SPLIT_STEP, changesListHeight, changesListMax, dragChangesSplit } from '@kestrel/server/changes-split';
import { tabActions, useTabs } from '../tabsStore.ts';

/** Follows an element's height while it is on the page. */
function useHeight(ref: RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setHeight(el.getBoundingClientRect().height);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return height;
}

export function ChangesSplit({ list, diff }: { list: ReactNode; diff: ReactNode }) {
  const stored = useTabs((v) => v.sidebar.changesListHeight);
  const box = useRef<HTMLDivElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  const pane = useHeight(box);
  const content = useHeight(rows);
  const height = changesListHeight(stored, pane, content);
  const max = changesListMax(pane);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const startY = event.clientY;
    handle.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => tabActions.setChangesListHeight(dragChangesSplit(height, e.clientY - startY, pane));
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  };
  const moveTo = (px: number) => tabActions.setChangesListHeight(dragChangesSplit(px, 0, pane));

  return (
    <div className="changes-split" ref={box}>
      <div className="changes-list-region" style={{ height }}>
        <div ref={rows}>{list}</div>
      </div>
      <div
        className="changes-split-bar"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the file list and the diff"
        aria-valuemin={CHANGES_LIST_HEIGHT.min}
        aria-valuemax={max}
        aria-valuenow={height}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onDoubleClick={() => tabActions.setChangesListHeight(null)}
        onKeyDown={(e) => {
          const to = e.key === 'ArrowUp' ? height - CHANGES_SPLIT_STEP : e.key === 'ArrowDown' ? height + CHANGES_SPLIT_STEP : e.key === 'Home' ? CHANGES_LIST_HEIGHT.min : e.key === 'End' ? max : null;
          if (to === null) return;
          e.preventDefault();
          moveTo(to);
        }}
      />
      <div className="changes-diff-region">{diff}</div>
    </div>
  );
}
