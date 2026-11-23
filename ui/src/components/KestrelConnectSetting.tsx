// Settings → Connections → Kestrel Connect (design doc kestrel-connect.md, section 9): signed in or
// out, Sign in / Sign out, the one switch (off by default; it saves as it is changed) and the
// link's state. Everything shown is the server's `ConnectView`, read from the store's `connect`
// slice (connectStore.ts); nothing here keeps a copy.
import { ExternalLink, LogIn, LogOut, Smartphone } from 'lucide-react';
import { linkText, type ConnectView } from '@kestrel/server/connect';
import { connectActions, useConnect } from '../connectStore.ts';
import { thisComputer } from '../platform.ts';
import { opener, openView } from '../route.ts';
import { SettingSection } from './SettingHelp.tsx';

function Account({ view }: { view: ConnectView }) {
  const { account } = view;
  if (account.state === 'signing-in')
    return (
      <div className="sign-in" role="status">
        <p className="sign-in-note">
          Finish signing in in your browser. <a href={account.url} target="_blank" rel="noreferrer">Open the sign-in page <ExternalLink aria-hidden /></a>
        </p>
        <button type="button" className="secondary-button small" onClick={() => void connectActions.cancelSignIn()}>
          Cancel
        </button>
      </div>
    );
  if (account.state === 'signed-in')
    return (
      <div className="sign-in">
        <p className="sign-in-note">Signed in as {account.email}</p>
        <button type="button" className="secondary-button small" onClick={() => void connectActions.signOut()}>
          <LogOut aria-hidden /> Sign out
        </button>
      </div>
    );
  return (
    <div className="sign-in">
      <p className="sign-in-note" role={account.reason ? 'alert' : undefined}>
        {account.reason ? `Signed out: ${account.reason}` : 'Signed out'}
      </p>
      <button type="button" className="secondary-button small" onClick={() => void connectActions.signIn()}>
        <LogIn aria-hidden /> Sign in
      </button>
    </div>
  );
}

function Devices({ view }: { view: ConnectView }) {
  const connected = view.link.state === 'connected';
  return (
    <div className="connect-devices">
      <div className="connect-devices-heading"><h3>Paired devices</h3><span className="settings-status">{view.paired.length}</span></div>
      {view.paired.length === 0 ? (
        <p className="settings-help">No phone is paired with {view.computerName}.</p>
      ) : (
        <ul className="connect-device-list">
          {view.paired.map((device) => (
            <li key={device.id}>
              <Smartphone className="connect-device-icon" aria-hidden />
              <div className="connect-device-detail"><span className="connect-device-name">{device.name}</span><span className="settings-help">{device.connected ? 'Connected now' : `Paired ${new Date(device.pairedAt).toLocaleDateString()}`}</span></div>
              <button type="button" className="secondary-button small" aria-label={`Remove ${device.name}`} onClick={() => void connectActions.removeDevice(device.id, device.name)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div>
        <button type="button" className="secondary-button small" disabled={!connected} title={connected ? undefined : 'Connect first'} {...opener((newTab) => openView({ kind: 'settings', section: 'connections/pair' }, newTab))}>
          <Smartphone aria-hidden /> Pair a phone
        </button>
      </div>
      {!connected && <p className="settings-help">Connect this computer to pair a phone.</p>}
    </div>
  );
}

function Controls() {
  const view = useConnect();
  if (!view) return <p className="settings-help">Loading…</p>;
  if (view.unavailable) return <p className="settings-help">{view.unavailable}</p>;
  const signedIn = view.account.state === 'signed-in';
  return (
    <>
      <Account view={view} />
      <label className="tag-rule-switch">
        <input type="checkbox" checked={view.enabled} onChange={(e) => void connectActions.setEnabled(e.target.checked)} />
        Connect {view.computerName} to Kestrel Connect
      </label>
      {view.enabled && signedIn && (
        <p className="settings-help" role="status">
          {linkText(view.link)}
        </p>
      )}
      {view.enabled && !signedIn && view.account.state !== 'signing-in' && <p className="settings-help">Sign in to connect.</p>}
      {signedIn && <Devices view={view} />}
      {view.storage === 'file' && <p className="settings-help">There is no keychain Kestrel can use on {thisComputer()}, so your sign-in is kept in a file only your user account can read.</p>}
    </>
  );
}

const HELP = (
  <p className="settings-help">
    Kestrel Connect lets your phone reach the sessions on this computer through Kestrel's relay, without opening a port here. This computer dials out only while the switch is on and you are signed in. Your sign-in is kept in this computer's keychain, never in Kestrel's
    database. Off unless you turn it on.
  </p>
);

export function KestrelConnectSetting() {
  return (
    <SettingSection title="Kestrel Connect" help={HELP} className="settings-section connect-feature">
      <p className="connect-intro">Your sessions, on your phone.</p>
      <Controls />
    </SettingSection>
  );
}
