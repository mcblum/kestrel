// Settings → Git → Branch name prefix: what new sessions' branches start with (shared/branch-prefix.ts).
// Saved on the server as soon as it is chosen; a custom prefix is saved while typing, once it is a valid
// branch name part, and the reason is shown while it is not. Existing branches are never renamed.
import { SettingHeading } from './SettingHelp.tsx';
import { useRef, useState } from 'react';
import { branchName, customPrefixProblem, resolvePrefix, type BranchPrefixChoice, type BranchPrefixSetting } from '@kestrel/server/branch-prefix';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { GIT_SETTINGS_PATH, saveBranchPrefix, type AccountLogin, type GitSettingsView } from '../gitSettingsApi.ts';
import { useResource } from '../data/resources.ts';
import { messageFor, OLDER_SERVER, putResource, RESTART_REASON } from '../store.ts';

const EXAMPLE_TITLE = 'Fix login';
const EXAMPLE_ID = '3fa2b1c9';
const CUSTOM_FIELD_ID = 'branch-prefix-custom';

const asView = (raw: unknown): Sourced<GitSettingsView> => ready(raw as GitSettingsView);

function useBranchPrefix(view: GitSettingsView, onSaved: (view: GitSettingsView) => void) {
  const [choice, setChoice] = useState<BranchPrefixChoice>(view.branchPrefix.choice);
  const [draft, setDraft] = useState(view.branchPrefix.custom);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const saved = view.branchPrefix;
  const problem = customPrefixProblem(draft);

  const save = async (next: BranchPrefixSetting) => {
    const ask = ++latest.current;
    try {
      const answer = await saveBranchPrefix(next);
      if (ask !== latest.current) return;
      setError(null);
      onSaved(answer);
    } catch (e) {
      if (ask !== latest.current) return;
      setError(messageFor(e));
      if (next.choice !== 'custom') setChoice(saved.choice);
    }
  };
  const choose = (next: BranchPrefixChoice) => {
    setChoice(next);
    setError(null);
    if (next !== 'custom') void save({ choice: next, custom: problem ? saved.custom : draft });
    else if (!problem) void save({ choice: 'custom', custom: draft });
  };
  const type = (text: string) => {
    setDraft(text);
    if (customPrefixProblem(text) === null) void save({ choice: 'custom', custom: text });
  };
  return { choice, draft, problem, error, choose, type };
}

function Choice({ value, current, disabled, onChoose, children }: { value: BranchPrefixChoice; current: BranchPrefixChoice; disabled?: boolean; onChoose: (v: BranchPrefixChoice) => void; children: React.ReactNode }) {
  return (
    <label className={`settings-choice${disabled ? ' disabled' : ''}`}>
      <input type="radio" name="branch-prefix" value={value} checked={current === value} disabled={disabled} onChange={() => onChoose(value)} />
      {children}
    </label>
  );
}

/** "Your username (mcblum · GitHub)", or why there is none. */
function usernameLabel(username: AccountLogin) {
  return username.available ? (
    <>
      Your username ({username.login} · {username.service})
    </>
  ) : (
    <>
      Your username <small className="settings-choice-why">{username.reason}</small>
    </>
  );
}

function Editor({ view, onSaved }: { view: GitSettingsView; onSaved: (view: GitSettingsView) => void }) {
  const { choice, draft, problem, error, choose, type } = useBranchPrefix(view, onSaved);
  const login = view.username.available ? view.username.login : null;
  const showExample = choice !== 'custom' || !problem;
  const example = branchName(resolvePrefix({ choice, custom: problem ? '' : draft }, login), EXAMPLE_TITLE, EXAMPLE_ID);
  return (
    <>
      <div className="settings-choices" role="radiogroup" aria-labelledby="branch-prefix">
        <Choice value="username" current={choice} disabled={!view.username.available} onChoose={choose}>
          {usernameLabel(view.username)}
        </Choice>
        <Choice value="custom" current={choice} onChoose={choose}>
          Custom
        </Choice>
        {choice === 'custom' && (
          <div className="branch-prefix-custom">
            <label className="visually-hidden" htmlFor={CUSTOM_FIELD_ID}>Custom prefix</label>
            <input id={CUSTOM_FIELD_ID} className="form-control" value={draft} placeholder="team/yourname" autoComplete="off" spellCheck={false} aria-invalid={problem !== null} onChange={(e) => type(e.target.value)} />
            {problem && <p className="field-error">{problem}</p>}
          </div>
        )}
        <Choice value="kestrel" current={choice} onChoose={choose}>
          kestrel
        </Choice>
        <Choice value="none" current={choice} onChoose={choose}>
          None
        </Choice>
      </div>
      {showExample && (
        <p className="settings-help">
          New branches look like <code>{example}</code>. Existing branches keep their names.
        </p>
      )}
      {error && <p className="field-error">{error}</p>}
    </>
  );
}

export function BranchPrefixSetting() {
  // Held once in the app store; a save writes what the server stored back into it.
  const loaded = useResource(GIT_SETTINGS_PATH, asView).value;
  return (
    <section className="settings-section">
      <SettingHeading id="branch-prefix" title="Branch name prefix" help={<p className="settings-help">Prefix for new session branch names.</p>} />
      {loaded.state === 'ready' ? <Editor view={loaded.value} onSaved={(view) => putResource(GIT_SETTINGS_PATH, ready(view))} /> : <p className="settings-help">{loaded.state === 'loading' ? 'Loading…' : loaded.reason === RESTART_REASON ? OLDER_SERVER : loaded.reason}</p>}
    </section>
  );
}
