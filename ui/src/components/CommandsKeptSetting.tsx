// Settings → Workflow: "Commands kept per session" (server: shared/commands.ts, commands-kept/api.ts).
// One number, 0 for every command; checked as it is typed with the server's own rule. Held once in
// the app store through useResource; Save writes back what the server stored.
import { useDraft } from '../unsaved.ts';
import { useEffect, useId, useState } from 'react';
import { commandsKeptProblem } from '@kestrel/server/commands';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { useResource } from '../data/resources.ts';
import { SettingSection } from './SettingHelp.tsx';
import { act, call, OLDER_SERVER, putResource, RESTART_REASON } from '../store.ts';

const COMMANDS_KEPT_PATH = '/api/commands-kept';
type View = { kept: number; defaultKept: number };
const asView = (raw: unknown): Sourced<View> => ready(raw as View);

function CommandsKeptSettingControls() {
  const loaded = useResource(COMMANDS_KEPT_PATH, asView).value;
  const id = useId();
  const stored = loaded.state === 'ready' ? loaded.value.kept : null;
  const [text, setText] = useState('');
  useEffect(() => void (stored !== null && setText(String(stored))), [stored]);
  const value = text.trim() === '' ? NaN : Number(text);
  const problem = commandsKeptProblem(value);
  const save = async () => {
    const view = await act(() => call<View>(COMMANDS_KEPT_PATH, { method: 'PUT', body: JSON.stringify({ kept: value }) }));
    if (view) putResource(COMMANDS_KEPT_PATH, ready(view));
    return Boolean(view);
  };
  const anchor = useDraft({ what: 'Commands kept', changed: stored !== null && value !== stored, problem, save, discard: () => setText(String(stored ?? '')) });
  if (loaded.state !== 'ready') return <p className="settings-help">{loaded.state === 'loading' ? 'Loading…' : loaded.reason === RESTART_REASON ? OLDER_SERVER : loaded.reason}</p>;
  return (
    <>
      <div className="delegation-limit">
        <label htmlFor={id}>Keep the most recent</label>
        <span className="delegation-limit-field">
          <input id={id} type="number" min={0} step={1} inputMode="numeric" value={text} aria-invalid={problem !== null} onChange={(e) => setText(e.target.value)} />
          <span className="delegation-limit-default">Default {loaded.value.defaultKept} · 0 for every command</span>
        </span>
        {problem && <span className="delegation-limit-problem">{problem}</span>}
      </div>
<span ref={anchor} className="draft-anchor" />
    </>
  );
}

const HELP = (
  <>
    <p className="settings-help">How many commands each session's Commands pane keeps, with their output: running ones first, then the most recently ended. 0 keeps every command. A running command is never dropped.</p>
  </>
);

export function CommandsKeptSetting() {
  return (
    <SettingSection title="Commands kept per session" help={HELP}>
      <CommandsKeptSettingControls />
    </SettingSection>
  );
}
