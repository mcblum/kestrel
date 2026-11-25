// Settings → Connections → Kestrel Connect → Set up this computer (`#/settings/connections/setup`;
// docs/designs/onboarding.md, sections 3 and 7): a page in the main canvas, never a panel from the
// side. What the account's other computers have and this one lacks, in seven groups, each line with
// its kind, what it does, the secrets it needs here by name, and its check; what is already here is
// folded away under each group. In this stage only Sign in to Claude and Sign in to Codex act; every
// other line says what it will do. Asked for each time the page opens, so every check is current.
import { ArrowLeft, Check, Circle, RefreshCw } from 'lucide-react';
import { SETUP_GROUPS, SETUP_KIND_TEXT, setupLeft, setupToDo, type SetupLine } from '@kestrel/server/setup-list';
import { useResource } from '../data/resources.ts';
import { thisComputer } from '../platform.ts';
import { opener, openView } from '../route.ts';
import { asSetupList, SETUP_PATH } from '../setupList.ts';
import { SettingHeading } from './SettingHelp.tsx';
import { SignIn } from './SignIn.tsx';
import { useAgentStatus } from './useAgents.ts';

const backToConnections = opener((newTab) => openView({ kind: 'settings', section: 'connections' }, newTab));

const when = (at: number) => {
  const d = new Date(at);
  return d.toDateString() === new Date().toDateString() ? `today at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

function Line({ line }: { line: SetupLine }) {
  const Mark = line.done ? Check : Circle;
  return (
    <li className={`setup-line${line.done ? ' is-done' : ''}`}>
      <Mark className="setup-line-mark" aria-label={line.done ? 'Done here' : 'Not done here'} />
      <div className="setup-line-detail">
        <span className="setup-line-title">{line.title}</span>
        <span className="settings-help">{line.does}</span>
        {line.secrets.length > 0 && (
          <span className="settings-help">
            Needs here:{' '}
            {line.secrets.map((s, i) => (
              <span key={s}>
                {i > 0 && ', '}
                <code>{s}</code>
              </span>
            ))}
          </span>
        )}
        <span className="setup-line-from">On {line.from.join(' and ')}</span>
        {line.action && !line.done && <SignIn agent={line.action.agent} small />}
      </div>
      <span className="settings-status setup-line-kind">{SETUP_KIND_TEXT[line.kind]}</span>
    </li>
  );
}

function Group({ title, lines }: { title: string; lines: SetupLine[] }) {
  const open = lines.filter((l) => !l.done);
  const here = lines.filter((l) => l.done);
  const left = lines.filter(setupToDo).length;
  return (
    <section className="settings-section setup-group">
      <div className="setup-group-heading">
        <h2>{title}</h2>
        <span className="settings-status">{left === 0 ? 'Done' : `${left} to do`}</span>
      </div>
      {open.length > 0 && (
        <ul className="setup-lines">
          {open.map((line) => (
            <Line key={line.id} line={line} />
          ))}
        </ul>
      )}
      {here.length > 0 && (
        <details className="setup-already">
          <summary>Already here ({here.length})</summary>
          <ul className="setup-lines">
            {here.map((line) => (
              <Line key={line.id} line={line} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

export function SetupThisComputerPage() {
  // A sign-in that finishes changes which agents are ready: the list is asked again.
  const agents = useAgentStatus();
  const { value, refresh } = useResource(SETUP_PATH, asSetupList, agents?.available.join(',') ?? '');
  const here = thisComputer();
  const back = (
    <div>
      <button type="button" className="secondary-button small" {...backToConnections}>
        <ArrowLeft aria-hidden /> Back to Connections
      </button>
    </div>
  );
  const help = <p className="settings-help">What your other computers have that {here} does not. Nothing secret is copied from them: each sign-in is made here, and each value is entered here. Every line checks itself each time this page opens.</p>;
  if (value.state !== 'ready')
    return (
      <>
        <SettingHeading level={1} title={`Set up ${here}`} help={help} />
        <section className="settings-section">
          <p className="settings-help" role={value.state === 'unavailable' ? 'alert' : 'status'}>{value.state === 'unavailable' ? value.reason : 'Reading your computers…'}</p>
          {back}
        </section>
      </>
    );
  const list = value.value;
  const left = setupLeft(list);
  return (
    <>
      <SettingHeading level={1} title={`Set up ${here}`} help={help} />
      <section className="settings-section setup-summary">
        {list.others.length === 0 ? (
          <p className="settings-help">No other computer in your account has written its set-up yet. Open Settings → Connections on that computer while it is connected, then come back.</p>
        ) : (
          <p className="settings-help" role="status">
            From {list.others.map((o) => `${o.name} (read ${when(o.readAt)})`).join(', ')}. {left === 0 ? `${list.here.name} has what they have.` : `${left} left to do.`}
          </p>
        )}
        {list.problems.length > 0 && <p className="settings-help">On {list.here.name}: {list.problems.join(' ')}</p>}
        <div className="setup-summary-actions">
          <button type="button" className="secondary-button small" onClick={() => void refresh()}>
            <RefreshCw aria-hidden /> Check again
          </button>
          <button type="button" className="secondary-button small" {...backToConnections}>
            <ArrowLeft aria-hidden /> Back to Connections
          </button>
        </div>
      </section>
      {SETUP_GROUPS.map((g) => {
        const lines = list.lines.filter((l) => l.group === g.id);
        return lines.length > 0 ? <Group key={g.id} title={g.title} lines={lines} /> : null;
      })}
    </>
  );
}
