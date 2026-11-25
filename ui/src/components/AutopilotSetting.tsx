// Settings → Git → Autopilot (server: git-settings/prefs.ts, shared/autopilot.ts; docs/designs/pr-autopilot.md):
// whether it is offered when a session's pull request appears, the rounds and a round's time limit, whether
// Merge when green starts ticked, and Always turn it on, which is stored only once its warning is agreed to
// (confirmed in place, as Code reviews' "Review and reply on their own" is). Switches and selects save as
// they are changed.
import { useState } from 'react';
import { ALWAYS_WARNING, minutesText, ROUND_MINUTE_CHOICES, ROUNDS_MAX, ROUNDS_MIN, DEFAULT_AUTOPILOT_PREFS, type AutopilotPrefs } from '@kestrel/server/autopilot';
import { changeAutopilot, useAutopilotSetting } from '../autopilotPrefs.ts';
import { OLDER_SERVER, RESTART_REASON } from '../store.ts';
import { SettingSection } from './SettingHelp.tsx';

const ROUNDS = Array.from({ length: ROUNDS_MAX - ROUNDS_MIN + 1 }, (_, i) => ROUNDS_MIN + i);
const defaultMark = (yes: boolean) => (yes ? ' (default)' : '');

function Always({ prefs }: { prefs: AutopilotPrefs }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <label className="tag-rule-switch">
        <input type="checkbox" checked={prefs.always || confirming} onChange={(e) => (e.target.checked ? setConfirming(true) : (setConfirming(false), void changeAutopilot({ always: false })))} />
        Always turn it on, without asking
      </label>
      {confirming && !prefs.always ? (
        <div className="review-setting-warning" role="alertdialog" aria-label="Confirm turning Autopilot on for every pull request">
          <p>{ALWAYS_WARNING}</p>
          <div>
            <button type="button" className="primary-button small" onClick={() => (setConfirming(false), void changeAutopilot({ always: true, confirmed: true }))}>
              Turn it on for every pull request
            </button>
            <button type="button" className="secondary-button small" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function Controls() {
  const loaded = useAutopilotSetting().value;
  if (loaded.state !== 'ready') return <p className="settings-help">{loaded.state === 'loading' ? 'Loading…' : loaded.reason === RESTART_REASON ? OLDER_SERVER : loaded.reason}</p>;
  const prefs = loaded.value;
  return (
    <div className="attention-settings">
      <label className="tag-rule-switch">
        <input type="checkbox" checked={prefs.offer} onChange={(e) => void changeAutopilot({ offer: e.target.checked })} />
        Offer it when a session’s pull request is opened
      </label>
      <label className="tag-rule-switch">
        <input type="checkbox" checked={prefs.merge} onChange={(e) => void changeAutopilot({ merge: e.target.checked })} />
        Tick “Merge it when it is green” to begin with
      </label>
      <label className="autopilot-setting-choice">
        Rounds before it stops and tells you
        <select aria-label="Rounds" className="form-control" value={prefs.rounds} onChange={(e) => void changeAutopilot({ rounds: Number(e.target.value) })}>
          {ROUNDS.map((n) => (
            <option key={n} value={n}>
              {n}
              {defaultMark(n === DEFAULT_AUTOPILOT_PREFS.rounds)}
            </option>
          ))}
        </select>
      </label>
      <label className="autopilot-setting-choice">
        A round’s time limit
        <select aria-label="A round’s time limit" className="form-control" value={prefs.roundMinutes} onChange={(e) => void changeAutopilot({ roundMinutes: Number(e.target.value) })}>
          {[...new Set([...ROUND_MINUTE_CHOICES, prefs.roundMinutes])].sort((a, b) => a - b).map((m) => (
            <option key={m} value={m}>
              {minutesText(m)}
              {defaultMark(m === DEFAULT_AUTOPILOT_PREFS.roundMinutes)}
            </option>
          ))}
        </select>
      </label>
      <Always prefs={prefs} />
    </div>
  );
}

const HELP = (
  <>
    <p className="settings-help">
      Autopilot looks after a session’s pull request. When its checks fail, it conflicts with its target or a reviewer asks for changes, Kestrel sends the agent the fix as a turn, and the agent fixes it and pushes. A round lasts until the checks on what it pushed have reported. With “Merge it when it is green” ticked, it merges once the host says the request is ready.
    </p>
    <p className="settings-help">
      It stops and tells you when the rounds are used up, the same checks fail again, the agent pushes nothing, a round goes over its time limit, or someone else pushes. Sending a message in the session takes it back. Every round runs in the session’s own mode: in Manual the agent still asks.
    </p>
  </>
);

export function AutopilotSetting() {
  return (
    <SettingSection title="Autopilot" help={HELP}>
      <Controls />
    </SettingSection>
  );
}
