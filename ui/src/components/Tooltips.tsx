// One tooltip for the whole app. Any button (or anything else) with a `title`, and any button
// that shows only an icon and has an `aria-label`, gets a small popup after a short hover or on
// keyboard focus. The browser's own slow tooltip is turned off for those elements. It sits
// centred above the element, or below it when there is no room above, kept inside the window
// (usePopupPlacement).
import { useEffect, useRef, useState } from 'react';
import type { Rect } from '@kestrel/server/popup-place';
import { rectOf, usePopupPlacement } from './usePopupPlacement.ts';

interface Tip {
  text: string;
  anchor: Rect;
}

/** Space between the element and its tooltip. */
const TIP_GAP = 6;

const DELAY_MS = 350;
const SELECTOR = '[title], [data-tip], button[aria-label], [role="separator"][aria-label]';

/** The text to show for an element, or null when it already says it in visible words. */
function tipFor(el: HTMLElement): string | null {
  // Take over from the native tooltip: keep the text, drop the attribute that triggers it.
  const title = el.getAttribute('title');
  if (title) {
    el.dataset.tip = title;
    el.removeAttribute('title');
  }
  if (el.dataset.tip) return el.dataset.tip;
  const label = el.getAttribute('aria-label');
  return label && !el.innerText.trim() ? label : null;
}

export function Tooltips() {
  const [tip, setTip] = useState<Tip | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let current: HTMLElement | null = null;
    const hide = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      current = null;
      setTip(null);
    };
    const show = (el: HTMLElement, delay: number) => {
      const text = tipFor(el);
      if (!text) return hide();
      if (el === current) return;
      hide();
      current = el;
      timer = setTimeout(() => {
        if (!el.isConnected) return;
        setTip({ text, anchor: rectOf(el) });
      }, delay);
    };
    const target = (event: Event) => (event.target instanceof Element ? event.target.closest<HTMLElement>(SELECTOR) : null);
    const over = (event: MouseEvent) => {
      const el = target(event);
      if (el) show(el, DELAY_MS);
      else hide();
    };
    const focus = (event: FocusEvent) => {
      const el = target(event);
      if (el?.matches(':focus-visible')) show(el, 0);
    };
    document.addEventListener('mouseover', over);
    document.addEventListener('mousedown', hide);
    document.addEventListener('keydown', hide);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', hide);
    document.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      hide();
      document.removeEventListener('mouseover', over);
      document.removeEventListener('mousedown', hide);
      document.removeEventListener('keydown', hide);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, []);
  return tip && <TipBox tip={tip} />;
}

function TipBox({ tip }: { tip: Tip }) {
  const box = useRef<HTMLDivElement>(null);
  usePopupPlacement(box, () => ({ anchor: tip.anchor, side: 'above', align: 'center', gap: TIP_GAP }), [tip]);
  return (
    <div ref={box} className="tooltip" role="tooltip">
      {tip.text}
    </div>
  );
}
