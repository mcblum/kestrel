// The bar's "more" button: the device controls used less often (volume, Siri, shake), in a small
// menu anchored under the button so the bar stays one line.
import { useEffect, useRef, useState } from 'react';
import { Ellipsis, Mic, Vibrate, Volume1, Volume2 } from 'lucide-react';
import { cannot, type SimButton, type SimCapabilities } from '@kestrel/server/simulator';
import { simulator } from '../simulatorStore.ts';
import { Popup } from './Popup.tsx';

const ITEMS: { label: string; icon: typeof Mic; button: SimButton | 'shake' }[] = [
  { label: 'Volume up', icon: Volume2, button: 'volume_up' },
  { label: 'Volume down', icon: Volume1, button: 'volume_down' },
  { label: 'Siri', icon: Mic, button: 'siri' },
  { label: 'Shake', icon: Vibrate, button: 'shake' },
];

export function SimMore({ udid, capabilities }: { udid: string | undefined; capabilities: SimCapabilities | null }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const why = (button: SimButton | 'shake') => (!capabilities ? 'The simulator is not ready.' : cannot(capabilities, button === 'shake' ? 'shake' : { button }));
  const press = (button: SimButton | 'shake') => {
    setOpen(false);
    if (!udid) return;
    void (button === 'shake' ? simulator.shake(udid) : simulator.button(udid, button));
  };

  return (
    <div className="sim-more" ref={root}>
      <button ref={button} type="button" className="sim-button" aria-label="More device controls" aria-haspopup="menu" aria-expanded={open} disabled={!udid} onClick={() => setOpen((o) => !o)}>
        <Ellipsis aria-hidden />
      </button>
      {open && (
        <Popup anchor={button} side="below" align="end" className="sim-more-menu" role="menu">
          {ITEMS.map(({ label, icon: Icon, button }) => {
            const reason = why(button);
            return (
              <button key={button} type="button" role="menuitem" disabled={Boolean(reason)} title={reason ?? undefined} onClick={() => press(button)}>
                <Icon aria-hidden />
                <span>{label}</span>
              </button>
            );
          })}
        </Popup>
      )}
    </div>
  );
}
