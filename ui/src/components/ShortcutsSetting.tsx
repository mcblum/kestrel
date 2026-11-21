// Settings → Keyboard shortcuts, a section of its own (Matt, 2026-11-20) (server: shared/shortcuts.ts; ui/src/shortcuts.ts): every
// command a key runs, found by what it does or by its keys, each changed by pressing the new key.
// A key another command has, or one that is reserved, is refused with the reason.
import { useEffect, useState } from 'react';
import { assignProblem, bindingFor, bindingOf, formatBinding, searchShortcuts, SHORTCUT_COMMANDS, type ShortcutCommand } from '@kestrel/server/shortcuts';
import { isMac, resetShortcuts, setShortcut, useShortcuts } from '../shortcuts.ts';
import { SettingHeading } from './SettingHelp.tsx';

function Row({ command, capturing, onCapture }: { command: ShortcutCommand; capturing: boolean; onCapture: (on: boolean) => void }) {
  const overrides = useShortcuts();
  const mac = isMac();
  const [problem, setProblem] = useState<string | null>(null);
  const binding = bindingFor(overrides, command.id);
  const changed = binding !== command.default;

  // While this row waits for a key, the next press is the new shortcut; it never reaches the app's own handling.
  useEffect(() => {
    if (!capturing) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation(); // not the app's own key handling either, whichever element has the focus
      if (event.key === 'Escape') return onCapture(false);
      const pressed = bindingOf(event, mac);
      if (!pressed) return; // a modifier on its own: keep waiting
      const why = assignProblem(overrides, command.id, pressed);
      setProblem(why);
      if (!why) {
        setShortcut(command.id, pressed);
        onCapture(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, command.id, mac, onCapture, overrides]);
  useEffect(() => void (!capturing && setProblem(null)), [capturing]);

  return (
    <li className="shortcut-row">
      <span className="shortcut-label">{command.label}</span>
      <span className="shortcut-keys">
        {capturing ? <em>Press the new keys…</em> : binding ? <kbd>{formatBinding(binding, mac)}</kbd> : <em>None</em>}
      </span>
      <span className="shortcut-actions">
        <button type="button" onClick={() => onCapture(!capturing)}>{capturing ? 'Cancel' : 'Change'}</button>
        {binding && !capturing && <button type="button" onClick={() => setShortcut(command.id, '')}>Remove</button>}
        {changed && !capturing && <button type="button" onClick={() => setShortcut(command.id, command.default)}>Reset</button>}
      </span>
      {capturing && problem && <span className="delegation-limit-problem shortcut-problem" role="alert">{problem}</span>}
    </li>
  );
}

function Controls() {
  const overrides = useShortcuts();
  const mac = isMac();
  const [query, setQuery] = useState('');
  const [capturing, setCapturing] = useState<string | null>(null);
  const found = searchShortcuts(query, overrides, mac);
  return (
    <>
      <input className="form-control shortcut-search" type="search" aria-label="Search shortcuts" placeholder="Search by what it does or by its keys" value={query} onChange={(e) => setQuery(e.target.value)} />
      <ul className="shortcut-list">
        {found.commands.map((command) => (
          <Row key={command.id} command={command} capturing={capturing === command.id} onCapture={(on) => setCapturing(on ? command.id : null)} />
        ))}
        {found.fixed.map((fixed) => (
          <li key={fixed.label} className="shortcut-row">
            <span className="shortcut-label">{fixed.label}</span>
            <span className="shortcut-keys"><kbd>{formatBinding(fixed.keys, mac)}</kbd></span>
            <span className="shortcut-actions shortcut-fixed">Cannot be changed</span>
          </li>
        ))}
      </ul>
      {found.commands.length + found.fixed.length === 0 && <p className="settings-help">No shortcut matches “{query}”.</p>}
      <div className="delegation-limits-actions">
        <button type="button" disabled={Object.keys(overrides).length === 0} onClick={resetShortcuts}>Reset all to defaults</button>
      </div>
    </>
  );
}

const HELP = (
  <p className="settings-help">
    The keys that run Kestrel's own commands. Choose Change and press the keys you want: a shortcut needs Cmd, Ctrl or Option, and one that another command already has, or that the system uses (Copy, Paste, Quit), is refused with the reason. Kept on this
    computer. {SHORTCUT_COMMANDS.length} can be changed; the rest are listed so they can be found.
  </p>
);

export function ShortcutsSetting() {
  return (
    <>
      {/* The page's own heading: this is a section of Settings by itself. */}
      <SettingHeading level={1} title="Keyboard shortcuts" help={HELP} />
      <section className="settings-section">
        <Controls />
      </section>
    </>
  );
}
