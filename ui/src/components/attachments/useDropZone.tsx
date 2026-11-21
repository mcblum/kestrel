// Dragging files over a page with a composer (a session, a new session) shows a drop zone over
// the page's whole main area; dropping anywhere on it attaches the files to that composer. Only
// drags that carry files count: the app's own drags (sidebar rows, tabs, attachment tiles) carry
// types of their own and pass through untouched. Enter and leave are counted, so crossing child
// elements does not flicker it; it goes on leave, drop, the end of any drag, and Escape. Nothing
// is drawn, and nothing is in the way, when no drag is in progress.
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Paperclip } from 'lucide-react';

/** The page areas a composer can sit in; the drop zone covers the one around it. */
const MAIN_AREA = '.session-workspace, .new-session';

const carriesFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;

type Box = { top: number; left: number; width: number; height: number };

function listen(main: HTMLElement, onActive: (box: Box | null) => void, onFiles: (files: File[]) => void): () => void {
  let depth = 0;
  const reset = () => {
    depth = 0;
    onActive(null);
  };
  const enter = (e: DragEvent) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    depth += 1;
    const r = main.getBoundingClientRect();
    onActive({ top: r.top, left: r.left, width: r.width, height: r.height });
  };
  const over = (e: DragEvent) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  };
  const leave = (e: DragEvent) => {
    if (!carriesFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) onActive(null);
  };
  const drop = (e: DragEvent) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    reset();
    onFiles([...(e.dataTransfer?.files ?? [])]);
  };
  const escape = (e: KeyboardEvent) => e.key === 'Escape' && reset();
  const pairs: [string, EventListener][] = [['dragenter', enter as EventListener], ['dragover', over as EventListener], ['dragleave', leave as EventListener], ['drop', drop as EventListener]];
  pairs.forEach(([type, fn]) => main.addEventListener(type, fn));
  window.addEventListener('dragend', reset);
  window.addEventListener('keydown', escape);
  return () => {
    pairs.forEach(([type, fn]) => main.removeEventListener(type, fn));
    window.removeEventListener('dragend', reset);
    window.removeEventListener('keydown', escape);
  };
}

/** The drop zone for the main area around `anchor` (the composer); render what it returns. */
export function useDropZone(anchor: RefObject<HTMLElement | null>, onFiles: (files: File[]) => void): ReactNode {
  const [box, setBox] = useState<Box | null>(null);
  const latest = useRef(onFiles);
  latest.current = onFiles;
  useEffect(() => {
    const main = anchor.current?.closest<HTMLElement>(MAIN_AREA);
    if (!main) return;
    return listen(main, setBox, (files) => latest.current(files));
  }, [anchor]);
  if (!box) return null;
  return createPortal(
    <div className="att-dropzone" style={box} aria-hidden>
      <div className="att-dropzone-inner">
        <Paperclip />
        <strong>Drop to attach</strong>
        <span>Images and files are added to your message</span>
      </div>
    </div>,
    document.querySelector('.kestrel') ?? document.body,
  );
}
