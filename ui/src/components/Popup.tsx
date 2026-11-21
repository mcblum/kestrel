// A popup that hangs from a button (a picker, the mode menu, the context ring's numbers): a plain
// div with the popup's own class and role, kept inside the window by usePopupPlacement. What opens
// and closes it, focus and keys stay with the component that renders it.
import { useRef, type HTMLAttributes, type RefObject } from 'react';
import type { Align, Side } from '@kestrel/server/popup-place';
import { opensUpward, rectOf, usePopupPlacement } from './usePopupPlacement.ts';

interface Props extends HTMLAttributes<HTMLDivElement> {
  /** The button it hangs from. */
  anchor: RefObject<HTMLElement | null>;
  /** The side it prefers; by default above in the composer's controls row, below anywhere else. */
  side?: Side | ((anchor: HTMLElement) => Side);
  /** How it lines up with the button when there is room; by default their left edges. */
  align?: Align | ((anchor: HTMLElement) => Align);
  gap?: number;
}

const pick = <T,>(value: T | ((el: HTMLElement) => T), el: HTMLElement): T => (typeof value === 'function' ? (value as (el: HTMLElement) => T)(el) : value);

export function Popup({ anchor, side, align = 'start', gap = 4, ...div }: Props) {
  const box = useRef<HTMLDivElement>(null);
  usePopupPlacement(
    box,
    () => {
      const el = anchor.current;
      if (!el) return null;
      return { anchor: rectOf(el), side: side === undefined ? (opensUpward(el) ? 'above' : 'below') : pick(side, el), align: pick(align, el), gap };
    },
    [anchor, gap],
  );
  return <div ref={box} {...div} />;
}
