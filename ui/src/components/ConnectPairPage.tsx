// Settings → Connections → Kestrel Connect → Pair a phone: a page in the main canvas
// (`#/settings/connections/pair`), never a panel from the side. It shows this computer's single-use
// code as a QR code and as text, until a phone pairs, the code expires, or the page is left.
import { useEffect, useState } from 'react';
import { toDataURL } from 'qrcode';
import { ArrowLeft } from 'lucide-react';
import { connectActions, useConnect } from '../connectStore.ts';
import { opener, openView } from '../route.ts';
import { SettingHeading } from './SettingHelp.tsx';

function Code({ code }: { code: string }) {
  const [picture, setPicture] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    toDataURL(code, { margin: 1, width: 240, errorCorrectionLevel: 'M' }).then((url) => live && setPicture(url), () => live && setPicture(null));
    return () => {
      live = false;
    };
  }, [code]);
  return (
    <>
      {picture && <img src={picture} width={240} height={240} alt="Pairing code to scan with the Kestrel app" />}
      <p className="settings-help">Or type this code in the Kestrel app:</p>
      <code className="settings-help" style={{ userSelect: 'all', wordBreak: 'break-all' }}>
        {code}
      </code>
    </>
  );
}

export function ConnectPairPage() {
  const view = useConnect();
  const pairedBefore = useState(() => view?.paired.length ?? 0)[0];
  // Opening the page asks for a code; leaving it withdraws the code.
  useEffect(() => {
    void connectActions.startPairing();
    return () => void connectActions.stopPairing();
  }, []);
  const back = (
    <button type="button" className="secondary-button small" {...opener((newTab) => openView({ kind: 'settings', section: 'connections' }, newTab))}>
      <ArrowLeft aria-hidden /> Back to Connections
    </button>
  );
  const paired = view && view.paired.length > pairedBefore ? view.paired.at(-1) : null;
  return (
    <>
      <SettingHeading level={1} title="Pair a phone" help={<p className="settings-help">The code works once, for ten minutes. Anyone who has it can pair a device with this computer, so show it only to your own phone.</p>} />
      <section className="settings-section">
        {paired ? (
          <p className="settings-help" role="status">
            Paired {paired.name}.
          </p>
        ) : view?.pairing ? (
          <>
            <p className="settings-help">Open Kestrel on your phone, signed in to the same account, and scan this code.</p>
            <Code code={view.pairing.code} />
          </>
        ) : (
          <p className="settings-help">{view && view.link.state !== 'connected' ? 'Turn Kestrel Connect on, sign in, and wait until it says Connected, then pair a phone.' : 'Getting a code…'}</p>
        )}
        <div>{back}</div>
      </section>
    </>
  );
}
