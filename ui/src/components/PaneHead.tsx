// Every side pane's close button, in the same spot: the far right of the shared-height header. A pane with no
// bar of its own gets a PaneHead (its name on the left, the X on the right); a pane that has its
// own bar (the browser's address bar, the simulator's controls, the terminal's tabs) puts a
// PaneClose at its end. Closing does what the pane's toolbar icon does: the pane turns off and
// stays mounted, keeping its state.
import { createContext, useContext, type ReactNode } from 'react';
import { X } from 'lucide-react';
import type { PaneId } from '@kestrel/server/pane-layout';

/** Turns a pane off. Provided by PaneArea for the page it lays out. */
export const PaneCloser = createContext<((pane: PaneId) => void) | null>(null);

export function PaneClose({ pane, name }: { pane: PaneId; name: string }) {
  const close = useContext(PaneCloser);
  // Outside a page's pane area there is nothing to close: draw nothing rather than a dead button.
  if (!close) return null;
  const label = `Close ${name}`;
  return (
    <button type="button" className="copy-button pane-close" aria-label={label} title={label} onClick={() => close(pane)}>
      <X aria-hidden />
    </button>
  );
}

export function PaneHead({ pane, name, children }: { pane: PaneId; name: string; /** Anything between the name and the X. */ children?: ReactNode }) {
  return (
    <div className="pane-head">
      <span className="pane-head-name">{name}</span>
      {children}
      <PaneClose pane={pane} name={name} />
    </div>
  );
}
