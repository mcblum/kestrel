// Settings → Connections → Kestrel Connect, its held-conversations part (design doc kestrel-connect.md,
// sections 5, 7 and 9): the account key and the recovery key, which projects are kept off, and whether
// attachments are held. Switches save as they are changed; nothing here is typed. Everything shown is
// the server's `ConnectView` from the store's `connect` slice, and the projects from the workspace.
import { KeyRound } from 'lucide-react';
import { keptOffWith, type ConnectView } from '@kestrel/server/connect';
import { connectActions, useConnect } from '../connectStore.ts';
import { opener, openView } from '../route.ts';
import { useApp } from '../store.ts';

/** Stands for sessions with no project in the kept-off list (server/src/connect/link/held.ts). */
const NO_PROJECT = 'none';

const openRecovery = opener((newTab) => openView({ kind: 'settings', section: 'connections/recovery' }, newTab));

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function KeyState({ view }: { view: ConnectView }) {
  const { keys } = view;
  if (keys.state === 'unknown') return <p className="settings-help">Held conversations start once this computer is connected.</p>;
  if (keys.state === 'failed') return <p className="settings-help" role="alert">{keys.reason}</p>;
  if (keys.state === 'locked')
    return (
      <>
        <p className="settings-help" role="status">{keys.reason}</p>
        <div>
          <button type="button" className="secondary-button small" {...openRecovery}>
            <KeyRound aria-hidden /> Enter recovery key
          </button>
        </div>
      </>
    );
  return (
    <>
      {keys.wordsToShow && (
        <p className="settings-help" role="status">
          {keys.changedBecause && keys.changedBecause.length > 0
            ? `Your recovery key changed when ${keys.changedBecause.join(' and ')} ${keys.changedBecause.length === 1 ? 'was' : 'were'} removed. The words you wrote down before no longer work: write down the new ones.`
            : 'Write down your recovery key. Without it, if you lose every device, your held conversations are lost.'}
        </p>
      )}
      <div>
        <button type="button" className={keys.wordsToShow ? 'primary-button small' : 'secondary-button small'} {...openRecovery}>
          <KeyRound aria-hidden /> {keys.wordsToShow ? 'Write down the recovery key' : 'Show recovery key'}
        </button>
      </div>
    </>
  );
}

/** Which phones are told when a session finishes, fails or needs you (Kestrel Connect phase 6). */
export function ConnectPushSetting({ view }: { view: ConnectView }) {
  const { push } = view;
  const names = push.phones;
  return (
    <div className="connect-devices">
      <div className="connect-devices-heading"><h3>Notifications on your phone</h3></div>
      <p className="settings-help">
        {names.length === 0
          ? 'No phone takes notifications yet. Turn them on in Kestrel on your phone.'
          : `${names.join(' and ')} ${names.length === 1 ? 'is' : 'are'} told when a session finishes, fails or needs you, even with no Kestrel window open. Each phone chooses which in its own settings. What a notification says is encrypted here; Kestrel Connect and Apple cannot read it.`}
      </p>
      {push.problem && <p className="settings-help" role="alert">{push.problem}</p>}
    </div>
  );
}

/** Switches one project on or off Kestrel Connect, saved as it is changed; what was held of it is deleted. */
function keepOff(keptOff: readonly string[], projectId: string, off: boolean): void {
  void connectActions.setHeld({ keptOff: keptOffWith(keptOff, projectId, off) });
}

/** The same switch in a project's own Settings tab: the one list Settings → Connections shows too. */
export function ConnectKeepOffSwitch({ projectId, projectName }: { projectId: string; projectName: string }) {
  const view = useConnect();
  if (!view) return null;
  const { keptOff } = view.held;
  return (
    <>
      <label className="tag-rule-switch">
        <input type="checkbox" checked={keptOff.includes(projectId)} onChange={(e) => keepOff(keptOff, projectId, e.target.checked)} />
        Keep {projectName} off Kestrel Connect
      </label>
      <p className="settings-help">Its sessions are never sent to your other devices, even encrypted, and what was held of them is deleted. The same switch is in Settings → Connections → Kestrel Connect.</p>
    </>
  );
}

export function ConnectHeldSetting({ view }: { view: ConnectView }) {
  const projects = useApp((s) => s.workspace?.projects);
  const { held } = view;
  const keptOff = new Set(held.keptOff);
  const toggle = (id: string, off: boolean) => keepOff(held.keptOff, id, off);
  const rows = [...(projects ?? []).map((p) => ({ id: p.id, name: p.name })), { id: NO_PROJECT, name: 'Sessions with no project' }];
  return (
    <div className="connect-devices">
      <div className="connect-devices-heading"><h3>Held conversations</h3></div>
      <p className="settings-help">
        Kestrel Connect keeps an encrypted copy of your conversations so your phone can read them while {view.computerName} is asleep. They are encrypted here with your account key before they leave; Kestrel Connect cannot read them.
      </p>
      <KeyState view={view} />
      {held.problem && <p className="settings-help" role="alert">{held.problem}</p>}
      {held.usage && <p className="settings-help">{formatBytes(held.usage.bytes)} of {formatBytes(held.usage.limit)} held on your account.</p>}
      <ul className="connect-held-projects">
        {rows.map((row) => (
          <li key={row.id}>
            <label className="tag-rule-switch">
              <input type="checkbox" checked={keptOff.has(row.id)} onChange={(e) => toggle(row.id, e.target.checked)} />
              Keep {row.name} off Kestrel Connect
            </label>
          </li>
        ))}
      </ul>
      <p className="settings-help">A project kept off is never sent, even encrypted, and what was held of it is deleted.</p>
      <label className="tag-rule-switch">
        <input type="checkbox" checked={held.attachments} onChange={(e) => void connectActions.setHeld({ attachments: e.target.checked })} />
        Hold attachments and tools’ pictures too
      </label>
      <p className="settings-help">
        Off: your phone sees their names and fetches them from {view.computerName} while it is on. When a device is removed, your account key is replaced; until {view.computerName} has re-encrypted what was held before, a removed device that kept a copy of it could still read that.
      </p>
    </div>
  );
}
