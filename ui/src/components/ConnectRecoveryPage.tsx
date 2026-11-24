// Settings → Connections → Kestrel Connect → Recovery key: a page in the main canvas
// (`#/settings/connections/recovery`), never a panel from the side. On a computer that holds the
// account key it shows the 24 words (asked for when the page opens, kept by this page only, never in
// the store) and puts them away once written down. On one that does not, the words are typed here to
// let it in: an action, like signing in, not a setting, so it has its own button and no Save bar.
import { useEffect, useState } from 'react';
import { ArrowLeft, KeyRound } from 'lucide-react';
import { connectActions, useConnect } from '../connectStore.ts';
import { opener, openView } from '../route.ts';
import { SettingHeading } from './SettingHelp.tsx';

const backToConnections = opener((newTab) => openView({ kind: 'settings', section: 'connections' }, newTab));

function Words() {
  const [words, setWords] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    void connectActions.recoveryWords().then((w) => live && setWords(w));
    return () => {
      live = false;
    };
  }, []);
  if (!words) return <p className="settings-help">Getting the recovery key…</p>;
  return (
    <>
      <p className="settings-help">Write these 24 words down, in order, and keep them somewhere safe and offline. With them, any computer or phone signed in to your account can read your held conversations, so show them to nobody.</p>
      <ol className="connect-recovery-words">
        {words.map((word, i) => (
          <li key={i}>{word}</li>
        ))}
      </ol>
      <div>
        <button type="button" className="primary-button small" onClick={() => void connectActions.recoveryPutAway().then(() => openView({ kind: 'settings', section: 'connections' }, false))}>
          I wrote them down
        </button>
      </div>
    </>
  );
}

function Enter() {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const count = text.trim() ? text.trim().split(/\s+/).length : 0;
  return (
    <>
      <p className="settings-help">Type the 24 words you wrote down when your account key was made, or when it last changed. Spaces and line breaks between them do not matter.</p>
      <textarea className="connect-recovery-input" rows={4} value={text} spellCheck={false} autoCapitalize="none" autoComplete="off" aria-label="Recovery words" onChange={(e) => setText(e.target.value)} />
      <p className="settings-help">{count} of 24 words</p>
      <div>
        <button
          type="button"
          className="primary-button small"
          disabled={busy || count !== 24}
          onClick={() => {
            setBusy(true);
            void connectActions.recover(text).then((ok) => {
              setBusy(false);
              if (ok) setText('');
            });
          }}
        >
          <KeyRound aria-hidden /> Use recovery key
        </button>
      </div>
    </>
  );
}

export function ConnectRecoveryPage() {
  const view = useConnect();
  const keys = view?.keys;
  return (
    <>
      <SettingHeading level={1} title="Recovery key" help={<p className="settings-help">Your held conversations are encrypted with your account key. The recovery key is the only way back to them if you lose every device; Kestrel Connect cannot recover them for you.</p>} />
      <section className="settings-section">
        {keys?.state === 'ready' ? <Words /> : keys?.state === 'locked' ? <Enter /> : <p className="settings-help">{keys?.state === 'failed' ? keys.reason : 'Turn Kestrel Connect on, sign in, and wait until it says Connected.'}</p>}
        <div>
          <button type="button" className="secondary-button small" {...backToConnections}>
            <ArrowLeft aria-hidden /> Back to Connections
          </button>
        </div>
      </section>
    </>
  );
}
