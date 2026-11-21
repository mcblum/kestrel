// When the message box's code colours are put on (boxColours.ts): after a draw, never in it, so a
// keystroke is drawn plain and coloured before the next frame (or, in a window not being painted,
// shortly after). A newer draw cancels a pending colouring, a colouring whose text is no longer the
// box's does nothing, and nothing is coloured while an input method is composing (rewriting the
// line would end the composition). The grammars load on the first block in a known language.
import { useCallback, useRef, type RefObject } from 'react';
import { colourBox, grammarsFor } from './boxColours.ts';

/** When the window is not painting frames (hidden), colour after this long instead. */
const COLOUR_FALLBACK_MS = 120;

interface Drawn {
  el: HTMLElement;
}

export function useBoxColours(box: RefObject<HTMLElement | null>, text: RefObject<string>, drawn: RefObject<readonly Drawn[]>, composing: RefObject<boolean>): () => void {
  const pending = useRef<{ frame: number; timer: number } | null>(null);

  const cancel = useCallback(() => {
    if (!pending.current) return;
    cancelAnimationFrame(pending.current.frame);
    window.clearTimeout(pending.current.timer);
    pending.current = null;
  }, []);

  // Not cancelled on unmount: a run finds the box gone and does nothing (and React's development
  // double mount would otherwise cancel the first draw's colouring).
  return useCallback(() => {
    cancel();
    const at = text.current;
    const run = () => {
      cancel();
      if (composing.current || !box.current?.isConnected || text.current !== at) return;
      const loading = grammarsFor(at);
      if (!loading) return colourBox(box.current, at, drawn.current);
      // Once loaded, colour what the box holds then (if it is still this text and not composing).
      void loading.then(() => !composing.current && box.current && text.current === at && colourBox(box.current, at, drawn.current), () => undefined);
    };
    pending.current = { frame: requestAnimationFrame(run), timer: window.setTimeout(run, COLOUR_FALLBACK_MS) };
  }, [box, text, drawn, composing, cancel]);
}
