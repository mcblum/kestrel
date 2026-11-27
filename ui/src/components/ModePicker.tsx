// The permission mode for a session, as a small menu that opens from its label: four numbered
// modes with a tick on the current one, and Bypass permissions on its own row with an Enable
// button. Keys 1 to 4 choose a mode while the menu is open.
import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { Popup } from './Popup.tsx';
import { opensUpward } from './usePopupPlacement.ts';
import { PERMISSION_LEVELS, permissionHint, SKIP_PROMPTS, SKIP_PROMPTS_CONFIRM, SKIP_PROMPTS_NOTE, type PermissionLevel } from '@kestrel/server/permissions';
import type { Agent } from '@kestrel/server/model';

const ALL = PERMISSION_LEVELS.map((m) => m.id);

interface Props {
  value: PermissionLevel;
  onChange: (next: PermissionLevel) => void;
  /** The levels the agent understands (its capabilities); all of them when absent. */
  levels?: readonly PermissionLevel[];
  /** The agent the session runs on: a mode's hint says what it does for that agent (`permissionHint`). */
  agent?: Agent;
  /** The tooltip of the label itself: what the current mode does. On the label only, never on the
   *  menu under it, where it would show over every row as if it were that row's own. */
  help?: string;
  /** Why Bypass cannot be switched on from here (a session on another computer): its row says so in place of Enable. */
  bypassRefusal?: string;
}

export function ModePicker({ value, onChange, levels = ALL, agent, help, bypassRefusal }: Props) {
  const LISTED = PERMISSION_LEVELS.filter((m) => m.place === 'listed' && levels.includes(m.id));
  const BYPASS = PERMISSION_LEVELS.find((m) => m.place === 'bypass' && levels.includes(m.id));
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const current = PERMISSION_LEVELS.find((m) => m.id === value) ?? LISTED[1] ?? PERMISSION_LEVELS[1]!;
  const bypassing = value === SKIP_PROMPTS;

  const choose = (next: PermissionLevel) => {
    setOpen(false);
    if (next === value) return;
    if (next === SKIP_PROMPTS && bypassRefusal) return;
    // Bypassing every prompt is confirmed each time it is switched on; declining changes nothing.
    if (next === SKIP_PROMPTS && !window.confirm(SKIP_PROMPTS_CONFIRM)) return;
    onChange(next);
  };

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !host.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return setOpen(false);
      const mode = LISTED[Number(e.key) - 1];
      if (mode && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        choose(mode.id);
      }
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  });

  return (
    <div className="picker mode-picker" ref={host}>
      <button ref={button} type="button" className={`picker-button${bypassing ? ' ctl-danger' : ''}`} aria-haspopup="menu" aria-expanded={open} aria-label={`Mode: ${current.label}`} title={help} onClick={() => setOpen((o) => !o)}>
        <span className="picker-value">{current.label}</span>
      </button>
      {open && (
        // In the composer's row the label sits at its right end: the menu hangs from the label's right edge.
        <Popup anchor={button} align={(a) => (opensUpward(a) ? 'end' : 'start')} gap={6} className="picker-pop mode-pop" role="menu" aria-label="Mode">
          <div className="mode-title">Mode</div>
          {LISTED.map((mode, i) => (
            <button key={mode.id} type="button" role="menuitemradio" aria-checked={mode.id === value} className="mode-row" onClick={() => choose(mode.id)}>
              <span className="mode-text">
                <strong>{mode.label}</strong>
                <small>{permissionHint(mode, agent)}</small>
              </span>
              {mode.id === value && <Check className="mode-check" aria-hidden />}
              <kbd>{i + 1}</kbd>
            </button>
          ))}
          {BYPASS && (
            <div className="mode-row mode-bypass">
              <span className="mode-text">
                <strong>{BYPASS.label}</strong>
                <small>{SKIP_PROMPTS_NOTE}</small>
              </span>
              {bypassing ? (
                <Check className="mode-check" aria-label="On" />
              ) : bypassRefusal ? (
                <small className="mode-refusal">{bypassRefusal}</small>
              ) : (
                <button type="button" className="mode-enable" onClick={() => choose(SKIP_PROMPTS)}>
                  Enable
                </button>
              )}
            </div>
          )}
        </Popup>
      )}
    </div>
  );
}
