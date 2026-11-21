// What Kestrel does when a session's pull request is merged (server: shared/cleanup-policy.ts,
// cleanup/api.ts): for every project (Settings → Git) or for one (its Settings tab → Git), which
// may follow the app-wide switches or have its own. Held once in the app store through useResource;
// a change writes back what the server stored.
import { GLOBAL_POLICY, NO_CLEANUP, POLICY_LABEL, policyFor, type CleanupPolicy, type PolicyByScope } from '@kestrel/server/cleanup-policy';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { useResource } from '../data/resources.ts';
import { act, call, OLDER_SERVER, putResource, RESTART_REASON } from '../store.ts';
import { SettingSection } from './SettingHelp.tsx';

const CLEANUP_PATH = '/api/cleanup-policy';
type Answer = { policies: PolicyByScope };
const asPolicies = (raw: unknown): Sourced<PolicyByScope> => ready((raw as Answer).policies ?? {});

const HELP = (
  <p className="settings-help">
    When a session's pull request is merged, Kestrel can put the session away for you. Work that exists nowhere else is never removed: a worktree with files that are not committed stays, and so does a branch with commits that were never pushed, and the session
    says what was kept and why. A session that is still working is left alone. The project's archive script runs first; if it fails, nothing is taken away. All off until you turn them on.
  </p>
);

function Switches({ policy, disabled, onChange }: { policy: CleanupPolicy; disabled: boolean; onChange: (next: CleanupPolicy) => void }) {
  return (
    <fieldset className="notify-events" disabled={disabled}>
      <legend>When its pull request is merged</legend>
      <label className="tag-rule-switch">
        <input type="checkbox" checked={policy.archive} onChange={(e) => onChange({ ...policy, archive: e.target.checked })} />
        {POLICY_LABEL.archive}
      </label>
      <label className="tag-rule-switch">
        <input type="checkbox" checked={policy.removeWorktree} onChange={(e) => onChange({ ...policy, removeWorktree: e.target.checked, deleteBranch: e.target.checked && policy.deleteBranch })} />
        {POLICY_LABEL.removeWorktree}, when nothing in it is uncommitted
      </label>
      <label className="tag-rule-switch">
        <input type="checkbox" checked={policy.deleteBranch} disabled={!policy.removeWorktree} onChange={(e) => onChange({ ...policy, deleteBranch: e.target.checked })} />
        {POLICY_LABEL.deleteBranch}, when everything on it was pushed
      </label>
    </fieldset>
  );
}

/** `scope`: a project's id, or GLOBAL_POLICY for every project. */
function Controls({ scope }: { scope: string }) {
  const loaded = useResource(CLEANUP_PATH, asPolicies).value;
  if (loaded.state !== 'ready') return <p className="settings-help">{loaded.state === 'loading' ? 'Loading…' : loaded.reason === RESTART_REASON ? OLDER_SERVER : loaded.reason}</p>;
  const all = loaded.value;
  const save = async (policy: CleanupPolicy | null) => {
    const answer = await act(() => call<Answer>(CLEANUP_PATH, { method: 'PUT', body: JSON.stringify({ scope, policy }) }));
    if (answer) putResource(CLEANUP_PATH, ready(answer.policies));
  };
  if (scope === GLOBAL_POLICY) return <Switches policy={all[GLOBAL_POLICY] ?? NO_CLEANUP} disabled={false} onChange={(next) => void save(next)} />;
  const own = all[scope];
  return (
    <>
      <label className="tag-rule-switch">
        <input type="checkbox" checked={own === undefined} onChange={(e) => void save(e.target.checked ? null : policyFor(all, null))} />
        Follow the app-wide setting (Settings → Git)
      </label>
      <Switches policy={own ?? policyFor(all, null)} disabled={own === undefined} onChange={(next) => void save(next)} />
    </>
  );
}

export function CleanupPolicySetting({ scope = GLOBAL_POLICY }: { scope?: string }) {
  return (
    <SettingSection title="After a merge" help={HELP}>
      <Controls scope={scope} />
    </SettingSection>
  );
}
