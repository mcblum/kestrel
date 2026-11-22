// One colour, shown as a single circle (Matt, 2026-11-22). A click fans the choices out from it in a
// row, to the right, or to the left where the window has no room on the right; a choice picks that
// colour, and a click anywhere else or Escape closes it unchanged. The row floats over the page like a
// menu: nothing moves under it.
import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type KeyboardEvent, type Ref } from 'react';
import { PALETTE, PALETTE_LABEL, type PaletteColour } from '@kestrel/server/colours';
import { paletteVar } from '../colours.ts';

/** One swatch's width plus the gap between swatches, in px (colours.css). */
const STEP = 28;
/** Room kept between the row and the window's edge, in px. */
const MARGIN = 16;
const CHOICES: readonly (PaletteColour | null)[] = [null, ...PALETTE];

const nameOf = (colour: PaletteColour | null): string => (colour ? PALETTE_LABEL[colour] : 'None');

interface SwatchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'style'> {
  colour: PaletteColour | null;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLButtonElement>;
}

function Swatch({ colour, className = '', style, ref, ...rest }: SwatchProps) {
  return (
    <button
      ref={ref}
      type="button"
      className={`colour-swatch${colour ? '' : ' none'}${className}`}
      style={{ ...(colour ? { '--swatch': paletteVar(colour) } : {}), ...style } as CSSProperties}
      title={nameOf(colour)}
      {...rest}
    />
  );
}

interface ColourPickerProps {
  /** What the colour is of, for a screen reader: "Colour of the tag Argus". */
  label: string;
  value: PaletteColour | null;
  onPick: (colour: PaletteColour | null) => void;
}

export function ColourPicker({ label, value, onPick }: ColourPickerProps) {
  const [open, setOpen] = useState(false);
  const [leftward, setLeftward] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  // Which way the row fits: to the right unless the window has no room there.
  useLayoutEffect(() => {
    if (!open || !box.current) return;
    const { left } = box.current.getBoundingClientRect();
    setLeftward(left + CHOICES.length * STEP + MARGIN > window.innerWidth);
    box.current.querySelector<HTMLButtonElement>('.colour-fan [aria-checked="true"]')?.focus();
  }, [open]);

  // A click anywhere outside closes it unchanged.
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => !box.current?.contains(event.target as Node) && setOpen(false);
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const pick = (colour: PaletteColour | null) => {
    close();
    if (colour !== value) onPick(colour);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    close();
  };

  return (
    <span className="colour-picker" ref={box} onKeyDown={onKeyDown}>
      <Swatch ref={trigger} colour={value} className=" colour-current" aria-label={`${label}: ${nameOf(value)}`} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)} />
      {open && (
        <span className={`colour-fan${leftward ? ' leftward' : ''}`} role="radiogroup" aria-label={label}>
          {CHOICES.map((colour, index) => (
            <Swatch
              key={colour ?? 'none'}
              colour={colour}
              role="radio"
              aria-checked={colour === value}
              aria-label={nameOf(colour)}
              style={{ '--i': index } as CSSProperties}
              onClick={() => pick(colour)}
            />
          ))}
        </span>
      )}
    </span>
  );
}
