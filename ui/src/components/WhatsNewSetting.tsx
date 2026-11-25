// Settings → General → What's new: the notes of this version (and earlier ones) on their own page,
// and the switch "Show what's new after an update". The switch is the server's record
// (server/src/whats-new/store.ts), pushed whole to the store's `whatsNew` slice and saved as it is
// changed; nothing is kept here.
import { Sparkles } from 'lucide-react';
import { act, useApp } from '../store.ts';
import { opener, openView } from '../route.ts';
import { setWhatsNewEnabled } from '../whatsNew.ts';
import { SettingSection } from './SettingHelp.tsx';

const HELP = (
  <p className="settings-help">
    The first time Kestrel opens after an update, it shows what changed in a new tab beside the one you were in. It does not take the front while that tab is a session waiting on you. A beta shows the notes of the release it leads
    to, and shows them again only when they have grown. The page is also in the Help menu.
  </p>
);

export function WhatsNewSetting() {
  const view = useApp((s) => s.whatsNew);
  if (!view) return null;
  const hasOwn = view.release !== null && view.releases.some((r) => r.release === view.release);
  return (
    <SettingSection title="What’s new" help={HELP}>
      <div>
        <button type="button" className="secondary-button small" disabled={view.releases.length === 0} {...opener((newTab) => openView({ kind: 'whats-new' }, newTab))}>
          <Sparkles aria-hidden /> {hasOwn ? `What’s new in ${view.release}` : 'Release notes'}
        </button>
      </div>
      <label className="tag-rule-switch">
        <input type="checkbox" checked={view.enabled} onChange={(e) => void act(() => setWhatsNewEnabled(e.target.checked))} />
        Show what’s new after an update
      </label>
    </SettingSection>
  );
}
