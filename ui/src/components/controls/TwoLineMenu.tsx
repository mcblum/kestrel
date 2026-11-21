// A box that opens a menu of two-line choices (a name, then what it is), for the settings where a
// native select's one line is not enough (Who does what: a role's presets, and how its work is
// sent). The box itself shows the chosen name and its second line. The menu is the app's own:
// Escape or a press outside closes it, arrows move, Enter chooses.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { Popup } from '../Popup.tsx';
import '../../styles/preset-menu.css';

export interface MenuChoice {
  key: string;
  name: string;
  /** The second line; absent for a one-line choice. */
  detail?: string;
  /** A tick when true; left undefined for an action (Remove, Create) that is not one of the choices. */
  checked?: boolean;
  /** Drawn in place of the tick: an action's own picture. */
  icon?: ReactNode;
  /** A rule above it. */
  separated?: boolean;
  run: () => void;
}

interface Props {
  id?: string;
  /** What the box is called to a screen reader. */
  label: string;
  /** What the box shows: a name, and a second line when there is one. */
  name: string;
  detail?: string;
  /** The box holds no choice of its own (an empty row's box): drawn muted. */
  muted?: boolean;
  disabled?: boolean;
  choices: readonly MenuChoice[];
  /** Said in the menu when there is nothing to choose. */
  none?: string;
}

export function TwoLineMenu({ id, label, name, detail, muted, disabled, choices, none }: Props) {
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    rows.current[focus]?.focus();
    const away = (e: MouseEvent) => !host.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open, focus]);

  const onKeys = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (step && choices.length > 0) setFocus((f) => (f + step + choices.length) % choices.length);
    else if (e.key === 'Escape') close(true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="roles-pick-host" ref={host}>
      <button
        ref={button}
        id={id}
        type="button"
        className={`form-control roles-pick${muted ? ' empty' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}: ${name}${detail ? `, ${detail}` : ''}`}
        disabled={disabled}
        onClick={() => (open ? close(true) : (setFocus(Math.max(0, choices.findIndex((c) => c.checked))), setOpen(true)))}
      >
        <span className="roles-pick-name">{name}</span>
        {detail && <span className="roles-pick-detail">{detail}</span>}
      </button>
      {open && (
        <Popup anchor={button} side="below" className="context-menu preset-menu" role="menu" aria-label={label} onKeyDown={onKeys}>
          {choices.length === 0 && none && <p className="roles-pick-none">{none}</p>}
          {choices.map((choice, i) => (
            <div key={choice.key} role="none">
              {choice.separated && <div className="menu-sep" role="separator" />}
              <button
                ref={(el) => void (rows.current[i] = el)}
                type="button"
                role={choice.checked === undefined ? 'menuitem' : 'menuitemradio'}
                aria-checked={choice.checked}
                className="preset-row-item"
                tabIndex={focus === i ? 0 : -1}
                onMouseEnter={() => setFocus(i)}
                onClick={() => {
                  close(true);
                  choice.run();
                }}
              >
                <span className="preset-tick">{choice.icon ?? (choice.checked && <Check aria-hidden />)}</span>
                <span className="preset-text">
                  <span className="preset-name">{choice.name}</span>
                  {choice.detail && <span className="preset-detail">{choice.detail}</span>}
                </span>
              </button>
            </div>
          ))}
        </Popup>
      )}
    </div>
  );
}
