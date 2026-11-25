// Settings → Connections → Kestrel Connect (design doc kestrel-connect.md, section 9): signed in or
// out, Sign in / Sign out, the one switch (off by default; it saves as it is changed) and the
// link's state. Everything shown is the server's `ConnectView`, read from the store's `connect`
// slice (connectStore.ts); nothing here keeps a copy.
import { useState } from 'react';
import { ExternalLink, ListChecks, LogIn, LogOut, Monitor, Smartphone } from 'lucide-react';
import { DEVICE_NAME_MAX, deviceNameOf, linkText, type ConnectDevice, type ConnectJoinRequest, type ConnectView } from '@kestrel/server/connect';
import { connectActions, useConnect } from '../connectStore.ts';
import { thisComputer } from '../platform.ts';
import { opener, openView } from '../route.ts';
import { useDraft } from '../unsaved.ts';
import { SettingSection } from './SettingHelp.tsx';
import { ConnectHeldSetting, ConnectPushSetting } from './ConnectHeldSetting.tsx';

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

const openSetup = opener((newTab) => openView({ kind: 'settings', section: 'connections/setup' }, newTab));

/** Whether another computer of the account could have a set-up record to build this one's list from. */
const canSetUp = (view: ConnectView) => view.link.state === 'connected' && view.keys.state === 'ready' && view.devices.some((d) => !d.here && d.kind === 'desktop' && d.inAccount);

/** Right after this computer was let in (onboarding.md 7, step 2): the offer to build its set-up list. */
function SetupOffer({ view }: { view: ConnectView }) {
  const [later, setLater] = useState(false);
  const others = view.devices.filter((d) => !d.here && d.kind === 'desktop' && d.inAccount).map((d) => d.name);
  if (later || others.length === 0) return null;
  return (
    <div className="connect-setup-offer">
      <p className="connect-join-title">Set up {thisComputer()} from your other machines?</p>
      <p className="settings-help">Kestrel lists what {others.join(' and ')} {others.length === 1 ? 'has' : 'have'} that {thisComputer()} does not: agents, git, tools, projects, MCP servers and agent settings. No password, token or key is copied; each one is signed in to or entered here.</p>
      <div className="connect-join-actions">
        <button type="button" className="primary-button small" {...openSetup}>
          <ListChecks aria-hidden /> Build the list
        </button>
        <button type="button" className="secondary-button small" onClick={() => setLater(true)}>
          Not now
        </button>
      </div>
    </div>
  );
}

const until = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Step 8a on this computer: the second code, shown on the device that let it in, typed here. */
function SecondCode({ by, problem, name }: { by: string; problem: string | null; name: string }) {
  const [code, setCode] = useState('');
  return (
    <div className="connect-join" role="alert">
      <p className="connect-join-title">{by} let {name} in</p>
      <form
        className="connect-join-form"
        onSubmit={(e) => {
          e.preventDefault();
          void connectActions.confirmJoin(code).then((ok) => ok && setCode(''));
        }}
      >
        <label className="settings-help" htmlFor="join-second-code">
          To finish, type the second code {by} shows now
        </label>
        <input id="join-second-code" className="form-control connect-join-input" inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="000 000" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
        <button type="submit" className="primary-button small" disabled={code.replace(/\D/g, '').length !== 6}>
          Finish
        </button>
        <button type="button" className="secondary-button small" onClick={() => void connectActions.cancelJoin()}>
          Cancel
        </button>
      </form>
      {problem ? <p className="settings-help" role="alert">{problem}</p> : <p className="settings-help">If {by} shows no second code, you did not let {name} in there: choose Cancel.</p>}
    </div>
  );
}

/** This computer asking to be let into the account: the code to type on the other device, then the last check (step 8a). */
function ThisComputerJoining({ view }: { view: ConnectView }) {
  const joining = view.joining;
  const name = view.computerName;
  const askAgain = (
    <div>
      <button type="button" className="secondary-button small" onClick={() => void connectActions.askToJoin()}>
        Ask again
      </button>
    </div>
  );
  if (joining?.state === 'in')
    return (
      <>
        <p className="settings-help" role="status">{joining.by} let {name} into your account.</p>
        {canSetUp(view) && <SetupOffer view={view} />}
      </>
    );
  if (joining?.state === 'confirm') return <SecondCode by={joining.by} problem={joining.problem} name={name} />;
  if (joining?.state === 'code')
    return (
      <div className="connect-join" role="status">
        <p className="connect-join-title">Type this code on {joining.by}</p>
        <code className="connect-join-code">{joining.code}</code>
        <p className="settings-help">Until {until(joining.expiresAt)}.</p>
      </div>
    );
  if (joining?.state === 'asking')
    return (
      <div className="connect-join" role="status">
        <p className="connect-join-title">{name} is asking to join your account</p>
        <p className="settings-help">On your phone or another computer signed in to Kestrel Connect, open the request and choose Let in. It shows a code to type there. The request is open until {until(joining.expiresAt)}.</p>
      </div>
    );
  if (joining?.state === 'ended')
    return (
      <div className="connect-join">
        <p className="settings-help" role="alert">{joining.reason}</p>
        {askAgain}
      </div>
    );
  if (view.keys.state !== 'locked') return null;
  return (
    <div className="connect-join">
      <p className="settings-help">{name} is not in your account yet. Ask to join, and let it in from a device that is.</p>
      {askAgain}
    </div>
  );
}

/** Another device asking to be let in: Let in, the code it shows, Allow; or Not me. */
function JoinRequest({ request }: { request: ConnectJoinRequest }) {
  const [code, setCode] = useState('');
  const Icon = request.kind === 'phone' ? Smartphone : Monitor;
  const notMe = (
    <button type="button" className="secondary-button small" onClick={() => void connectActions.refuseRequest(request.id)}>
      Not me
    </button>
  );
  return (
    <li>
      <Icon className="connect-device-icon" aria-hidden />
      <div className="connect-device-detail">
        <span className="connect-device-name">{request.state === 'showing' || request.state === 'done' ? request.name : `${request.name} wants to join your account`}</span>
        {request.state === 'done' ? (
          <span className="settings-help" role="status">{request.outcome}</span>
        ) : request.state === 'showing' ? (
          <>
            <span className="settings-help">{request.name} is let in. To finish, type this code on {request.name}:</span>
            <code className="connect-join-code">{request.code}</code>
          </>
        ) : request.state === 'typing' ? (
          <form
            className="connect-join-form"
            onSubmit={(e) => {
              e.preventDefault();
              void connectActions.typeCode(request.id, code).then((ok) => ok && setCode(''));
            }}
          >
            <label className="settings-help" htmlFor={`join-code-${request.id}`}>
              Type the code {request.name} shows
            </label>
            <input id={`join-code-${request.id}`} className="form-control connect-join-input" inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="000 000" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
            <button type="submit" className="primary-button small" disabled={code.replace(/\D/g, '').length !== 6}>
              Allow
            </button>
          </form>
        ) : (
          <span className="settings-help">{request.state === 'opening' ? `Waiting for ${request.name}…` : request.state === 'letting-in' ? `Letting ${request.name} in…` : `Open until ${until(request.expiresAt)}. Let it in only if you are setting it up now.`}</span>
        )}
        {request.problem && <span className="settings-help" role="alert">{request.problem}</span>}
      </div>
      {request.state === 'waiting' && (
        <button type="button" className="secondary-button small" onClick={() => void connectActions.openRequest(request.id)}>
          Let in
        </button>
      )}
      {(request.state === 'showing' || request.state === 'done') && (
        <button type="button" className="secondary-button small" onClick={() => void connectActions.dismissRequest(request.id)}>
          Done
        </button>
      )}
      {request.state !== 'letting-in' && request.state !== 'showing' && request.state !== 'done' && notMe}
    </li>
  );
}

const NAME_FIELD = 'connect-computer-name';

/** Why typed text cannot be a device's name, or null. */
function nameProblem(text: string, required: boolean): string | null {
  try {
    return deviceNameOf(text) === null && required ? 'A device needs a name.' : null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const sameName = (text: string, name: string | null): boolean => {
  try {
    return deviceNameOf(text) === name;
  } catch {
    return false;
  }
};

/** This computer's name: a draft saved by the screen's Save bar; empty is the host name. Needs no account. */
function ComputerName({ view }: { view: ConnectView }) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? view.givenName ?? '';
  const changed = text !== null && !sameName(text, view.givenName);
  const save = async () => {
    const saved = await connectActions.setName(shown);
    if (saved) setText(null);
    return saved;
  };
  const anchor = useDraft({ what: "This computer's name", changed, problem: nameProblem(shown, false), save, discard: () => setText(null) });
  return (
    <div className="connect-name">
      <label className="settings-help" htmlFor={NAME_FIELD}>
        Name
      </label>
      <input id={NAME_FIELD} className="form-control" maxLength={DEVICE_NAME_MAX} placeholder={view.hostName} value={shown} onChange={(e) => setText(e.target.value)} />
      <span ref={anchor} className="draft-anchor" />
      <p className="settings-help">What your phone and your other computers call this one. Left empty, it is {view.hostName}.</p>
      {view.nameProblem && <p className="settings-help" role="alert">{view.nameProblem}</p>}
    </div>
  );
}

/** Another device's new name, typed in its row: a draft saved by the screen's Save bar. */
function RenameDevice({ device, done }: { device: ConnectDevice; done: () => void }) {
  const [text, setText] = useState(device.name);
  const save = async () => {
    const saved = await connectActions.renameDevice(device.id, text);
    if (saved) done();
    return saved;
  };
  const anchor = useDraft({ what: `The name of ${device.name}`, changed: !sameName(text, device.name), problem: nameProblem(text, true), save, discard: done });
  return (
    <>
      <input className="form-control" aria-label={`New name for ${device.name}`} maxLength={DEVICE_NAME_MAX} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      <span ref={anchor} className="draft-anchor" />
    </>
  );
}

function deviceLine(device: ConnectDevice): string {
  if (device.here) return device.inAccount ? 'This computer' : 'This computer, not in your account yet';
  if (!device.inAccount) return 'Not let in';
  return device.connected ? 'Connected now' : 'In your account';
}

function Devices({ view }: { view: ConnectView }) {
  const connected = view.link.state === 'connected';
  const [renamingId, setRenamingId] = useState<string | null>(null);
  return (
    <div className="connect-devices">
      <ThisComputerJoining view={view} />
      {view.requests.length > 0 && (
        <ul className="connect-device-list" aria-label="Devices asking to join">
          {view.requests.map((request) => (
            <JoinRequest key={request.id} request={request} />
          ))}
        </ul>
      )}
      <div className="connect-devices-heading"><h3>Devices</h3><span className="settings-status">{view.devices.length}</span></div>
      {!connected ? (
        <p className="settings-help">Connect {view.computerName} to see the devices of your account.</p>
      ) : (
        <ul className="connect-device-list">
          {view.devices.map((device) => {
            const Icon = device.kind === 'phone' ? Smartphone : Monitor;
            const renaming = renamingId === device.id;
            return (
              <li key={device.id}>
                <Icon className="connect-device-icon" aria-hidden />
                <div className="connect-device-detail">
                  {renaming ? <RenameDevice device={device} done={() => setRenamingId(null)} /> : <span className="connect-device-name">{device.name}</span>}
                  <span className="settings-help">{deviceLine(device)}</span>
                </div>
                {!renaming && (
                  <button type="button" className="secondary-button small" aria-label={`Rename ${device.name}`} onClick={() => (device.here ? document.getElementById(NAME_FIELD)?.focus() : setRenamingId(device.id))}>
                    Rename
                  </button>
                )}
                {!device.here && (
                  <button type="button" className="secondary-button small" aria-label={`Remove ${device.name}`} onClick={() => void connectActions.removeDevice(device.id, device.name)}>
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {connected && view.keys.state === 'ready' && <p className="settings-help">To add your phone or another computer, sign in to Kestrel Connect there. It asks to join, and its request shows here.</p>}
      {canSetUp(view) && view.joining?.state !== 'in' && (
        <div>
          <button type="button" className="secondary-button small" {...openSetup}>
            <ListChecks aria-hidden /> Set up {thisComputer()}
          </button>
        </div>
      )}
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
      <ComputerName view={view} />
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
      {signedIn && view.enabled && <ConnectHeldSetting view={view} />}
      {signedIn && view.enabled && <ConnectPushSetting view={view} />}
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
