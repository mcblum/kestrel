// Settings → Workflow → Tag suggestions: the "Suggest tags" switch and the standing answers the user gave
// ("Always tag sessions with Jira tickets", "Don't ask again"), each changeable back to Ask, Always or
// Never. The list is derived from those answers, not ordered by the user, so it is sorted by name.
import { SettingSection } from './SettingHelp.tsx';
import { RULE_LABEL, RULE_VALUES, type RuleValue } from '@kestrel/server/tag-rules';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { useResource } from '../data/resources.ts';
import { OLDER_SERVER, putResource, RESTART_REASON } from '../store.ts';
import { changeTagPrefs, TAG_PREFS_PATH, type TagPrefsView } from '../suggestionsApi.ts';

const asPrefs = (raw: unknown): Sourced<TagPrefsView> => ready(raw as TagPrefsView);

function RuleList({ prefs, onChange }: { prefs: TagPrefsView; onChange: (key: string, value: RuleValue) => void }) {
  if (prefs.rules.length === 0) return <p className="settings-help">No standing answers yet. They appear here when you choose "Always…" or "Don't ask again" on a suggestion.</p>;
  return (
    <ul className="tag-rules">
      {prefs.rules.map((rule) => (
        <li key={rule.key}>
          <span>{rule.label}</span>
          <span className="tag-rule-values" role="group" aria-label={`${rule.label}: when to ask`}>
            {RULE_VALUES.map((value) => (
              <button key={value} type="button" aria-pressed={rule.value === value} onClick={() => rule.value !== value && onChange(rule.key, value)}>
                {RULE_LABEL[value]}
              </button>
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}

function TagSuggestionSettingsControls() {
  // Held once in the app store; a change writes what the server stored back into it.
  const loaded = useResource(TAG_PREFS_PATH, asPrefs).value;
  const change = async (patch: Parameters<typeof changeTagPrefs>[0]) => {
    const prefs = await changeTagPrefs(patch);
    if (prefs) putResource(TAG_PREFS_PATH, ready(prefs));
  };
  if (loaded.state !== 'ready') return <p className="settings-help">{loaded.state === 'loading' ? 'Loading…' : loaded.reason === RESTART_REASON ? OLDER_SERVER : loaded.reason}</p>;
  const prefs = loaded.value;
  return (
    <>
      <label className="tag-rule-switch">
        <input type="checkbox" checked={prefs.enabled} onChange={(e) => void change({ enabled: e.target.checked })} />
        Suggest tags
      </label>
      {prefs.enabled && <RuleList prefs={prefs} onChange={(key, value) => void change({ rule: { key, value } })} />}
    </>
  );
}

const HELP = (
  <>
    <p className="settings-help">When the work is tied to a ticket, release or feature named in your message, the session's title or its branch, the agent may suggest tagging the session with it. It never stops the work to ask.</p>
  </>
);

export function TagSuggestionSettings() {
  return (
    <SettingSection title="Tag suggestions" help={HELP}>
      <TagSuggestionSettingsControls />
    </SettingSection>
  );
}
