import type { PointerEvent as ReactPointerEvent } from 'react';

/** A column's left edge: drag to resize, double-click for the usual width, arrow keys when focused. */
export function ResizeEdge({ width, limits, onResize, label }: { width: number; limits: { min: number; max: number; initial: number }; onResize: (px: number) => void; label: string }) {
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const right = handle.parentElement!.getBoundingClientRect().right;
    handle.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => onResize(right - e.clientX);
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  };
  return (
    <div
      className="pane-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={limits.min}
      aria-valuemax={limits.max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => onResize(limits.initial)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') onResize(width + 24);
        if (e.key === 'ArrowRight') onResize(width - 24);
      }}
    />
  );
}
