// The computer a new session runs on (issue 52): "This Mac" by default, or another computer of the account by
// name. Shown only when the account has another computer. Its menu lists this computer and each other one; a
// computer that cannot take a session now, or has not answered yet, is greyed with the reason beside it. Each
// opening asks the others again, since whether they can be reached changes, and the open menu follows their
// answers as they arrive. The rules are shared/start-computer.ts.
import { useEffect, useRef, useState } from 'react';
import type { Machine } from '@kestrel/server/machines';
import type { MenuItem } from '@kestrel/server/menu';
import { computerOptions, type ComputerOption } from '@kestrel/server/start-computer';
import { contextMenu } from '../../menuState.ts';
import { thisComputer } from '../../platform.ts';
import { useComputerOffers } from '../../startComputers.ts';
import { menuOpenFrom, openFrom } from './anchor.ts';

/** "This Mac" or "This computer", as the pill names it. */
export const thisComputerName = (): string => {
  const words = thisComputer();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * The menu's rows: each computer, ticked where it is the chosen one, greyed with why where it cannot be chosen, and a
 * worker node behind its desktops with its update line beside it.
 */
const menuItems = (options: readonly ComputerOption[], value: string | null): MenuItem[] =>
  options.map((o) => ({ id: o.id ?? '', label: o.name, checked: o.id === value, ...(o.disabled ? { disabled: true, hint: o.disabled } : o.note ? { hint: o.note } : {}) }));

interface Props {
  /** The chosen computer's id; null: this one. */
  value: string | null;
  others: readonly Machine[];
  onChange: (machine: string | null) => void;
}

export function ComputerControl({ value, others, onChange }: Props) {
  const [asked, setAsked] = useState(0);
  const status = useComputerOffers(others.map((m) => m.id), String(asked));
  const button = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const name = value === null ? thisComputerName() : (others.find((m) => m.id === value)?.name ?? 'Another computer');
  const items = menuItems(computerOptions(thisComputerName(), others, status), value);
  // While this pill's menu is open, it shows each answer as it arrives. Compared as text: the rows are rebuilt on
  // every draw, and only a change in what they say should touch the open menu.
  const shown = JSON.stringify(items);
  useEffect(() => {
    if (menuOpenFrom(button.current)) contextMenu.replace(JSON.parse(shown) as MenuItem[]);
  }, [shown]);
  return (
    <span className="ctl ctl-computer">
      <button
        ref={button}
        type="button"
        className="ctl-button"
        aria-haspopup="menu"
        aria-label={`Runs on ${name}`}
        title={`Computer: ${name}. Where the session runs`}
        onPointerDown={() => void (wasOpen.current = menuOpenFrom(button.current))}
        onClick={() => {
          if (wasOpen.current) return void (wasOpen.current = false);
          setAsked((n) => n + 1);
          openFrom(button.current!, items, (item) => {
            const next = item.id === '' ? null : item.id;
            if (next !== value) onChange(next);
          });
        }}
      >
        <span className="ctl-label">{name}</span>
      </button>
    </span>
  );
}
