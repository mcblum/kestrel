export const canvasSizes = ['compact', 'comfortable'] as const;
export type CanvasSize = typeof canvasSizes[number];
export type CanvasFocus = 'working' | 'attention';

const SIZE_KEY = 'kestrel.canvas-card-size';

export function readCanvasSize(): CanvasSize {
  try {
    if (localStorage.getItem(SIZE_KEY) === 'compact') return 'compact';
  } catch {
    // The canvas still works when storage is blocked.
  }
  return 'comfortable';
}

export function saveCanvasSize(size: CanvasSize): void {
  try {
    localStorage.setItem(SIZE_KEY, size);
  } catch {
    // The current view keeps its size when storage is blocked.
  }
}

export function canvasCardState(waiting: boolean, running: boolean, unread: boolean) {
  return waiting ? 'attention' : running ? 'working' : unread ? 'unread' : 'quiet';
}

export function toggleCanvasFocus(current: CanvasFocus | null, selected: CanvasFocus | null): CanvasFocus | null {
  return current === selected ? null : selected;
}
