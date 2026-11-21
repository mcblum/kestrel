// The preset picker in the controls under the message box (server: shared/who-does-what.ts): one
// click sets the agent, model, effort and fast mode a saved preset names. Drawn only when there is
// a preset. Its menu gives each preset two lines: its name, then what it is in full (the agent, the
// model by its real name, the effort). In a running session the agent cannot change, so a preset of
// another agent is greyed, and its second line says why. The menu looks and closes like the app's
// others: Escape or a press outside closes it, arrows move, Enter chooses.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Settings2 } from 'lucide-react';
import { AGENT_LABEL } from '@kestrel/server/model';
import type { Controls } from '@kestrel/server/tabs';
import { applyPreset, matchingPreset, type ModelPreset } from '@kestrel/server/who-does-what';
import { openView } from '../../route.ts';
import { useWhoDoesWhat } from '../../whoDoesWhat.ts';
import { Popup } from '../Popup.tsx';
import { usePresetText } from './usePresetText.ts';
import '../../styles/preset-menu.css';

export function PresetControl({ value, running, onChange }: { value: Controls; running: boolean; onChange: (next: Controls) => void }) {
  const { presets } = useWhoDoesWhat();
  const describe = usePresetText();
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(0);
  const host = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  const current = matchingPreset(presets, value);
  const count = presets.length + 1; // every preset, then Edit presets
  /** A running session keeps its agent, so another agent's preset cannot be applied to it. */
  const locked = (preset: ModelPreset): boolean => running && preset.agent !== value.agent;

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

  if (presets.length === 0) return null;
  const choose = (preset: ModelPreset) => {
    if (locked(preset)) return;
    close(true);
    if (preset.id !== current?.id) onChange(applyPreset(value, preset));
  };
  const edit = () => {
    close(false);
    openView({ kind: 'settings', section: 'presets' });
  };
  const onKeys = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (step) setFocus((f) => (f + step + count) % count);
    else if (e.key === 'Escape') close(true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <span className="ctl ctl-preset" ref={host}>
      <button
        ref={button}
        type="button"
        className="ctl-button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={current ? `Preset: ${current.name} (${describe(current)})` : 'Preset: pick a saved agent, model and effort'}
        onClick={() => (open ? close(true) : (setFocus(Math.max(0, presets.findIndex((p) => p.id === current?.id))), setOpen(true)))}
      >
        {current ? current.name : 'Preset'}
      </button>
      {open && (
        <Popup anchor={button} align="end" className="context-menu preset-menu" role="menu" aria-label="Model presets" onKeyDown={onKeys}>
          {presets.map((preset, i) => (
            <button
              key={preset.id}
              ref={(el) => void (rows.current[i] = el)}
              type="button"
              role="menuitemradio"
              aria-checked={preset.id === current?.id}
              aria-disabled={locked(preset)}
              className={`preset-row-item${locked(preset) ? ' locked' : ''}`}
              tabIndex={focus === i ? 0 : -1}
              onMouseEnter={() => setFocus(i)}
              onClick={() => choose(preset)}
            >
              <span className="preset-tick">{preset.id === current?.id && <Check aria-hidden />}</span>
              <span className="preset-text">
                <span className="preset-name">{preset.name}</span>
                <span className="preset-detail">{describe(preset)}</span>
                {locked(preset) && <span className="preset-detail">This session runs on {AGENT_LABEL[value.agent]}, and a session keeps its agent.</span>}
              </span>
            </button>
          ))}
          <div className="menu-sep" role="separator" />
          <button ref={(el) => void (rows.current[presets.length] = el)} type="button" role="menuitem" className="preset-row-item" tabIndex={focus === presets.length ? 0 : -1} onMouseEnter={() => setFocus(presets.length)} onClick={edit}>
            <span className="preset-tick"><Settings2 aria-hidden /></span>
            <span className="preset-text"><span className="preset-name">Edit presets…</span></span>
          </button>
        </Popup>
      )}
    </span>
  );
}
