// Settings → Git → Pull requests that need you (server: git-settings/prefs.ts, shared/request-attention.ts):
// for each reason a finished session's pull request can need the user (its checks fail, it conflicts with
// its target, a reviewer asks for changes), whether it is watched at all, and whether its card is offered.
// A reason that is off is not looked at: no mark, no Overview line, no notification, no card. The card's
// "Don't ask again" is the same stored choice as its switch here. The notification itself has its one
// switch in Settings → Notifications. Switches save as they are changed.
import { ATTENTION_REASONS, type AttentionReason } from '@kestrel/server/request-attention';
import { changeAttention, useAttentionSetting } from '../attentionPrefs.ts';
import { OLDER_SERVER, RESTART_REASON } from '../store.ts';
import { SettingSection } from './SettingHelp.tsx';

const WORDS: Record<AttentionReason, { watch: string; card: string }> = {
  'checks-failed': { watch: 'Its checks fail', card: 'Offer to fix them' },
  conflicts: { watch: 'It has merge conflicts with its target branch', card: 'Offer to resolve them' },
  'changes-requested': { watch: 'A reviewer asks for changes', card: 'Offer to address them' },
};

function Controls() {
  const loaded = useAttentionSetting().value;
  if (loaded.state !== 'ready') return <p className="settings-help">{loaded.state === 'loading' ? 'Loading…' : loaded.reason === RESTART_REASON ? OLDER_SERVER : loaded.reason}</p>;
  return (
    <div className="attention-settings">
      {ATTENTION_REASONS.map((reason) => {
        const prefs = loaded.value[reason];
        return (
          <div key={reason} className="attention-setting">
            <label className="tag-rule-switch">
              <input type="checkbox" checked={prefs.watch} onChange={(e) => void changeAttention(reason, { watch: e.target.checked })} />
              {WORDS[reason].watch}
            </label>
            <label className="tag-rule-switch attention-card-switch">
              <input type="checkbox" checked={prefs.watch && prefs.card === 'ask'} disabled={!prefs.watch} onChange={(e) => void changeAttention(reason, { card: e.target.checked ? 'ask' : 'never' })} />
              {WORDS[reason].card}
            </label>
          </div>
        );
      })}
    </div>
  );
}

const HELP = (
  <>
    <p className="settings-help">
      When a session has finished its turn and its pull request needs you, its row shows the request’s mark in red with a cross, the Overview lists it under Needs you, and you are told once. A card in its conversation can offer to ask the agent to deal with it; nothing starts until you choose.
    </p>
    <p className="settings-help">A reason that is off is not watched at all. Whether you are told is the “A session’s pull request needs me” switch in Settings → Notifications.</p>
  </>
);

export function PullRequestsNeedYouSetting() {
  return (
    <SettingSection title="Pull requests that need you" help={HELP}>
      <Controls />
    </SettingSection>
  );
}
