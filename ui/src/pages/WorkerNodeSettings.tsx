import { useId, useMemo, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { deviceNameOf, type ConnectView } from '@kestrel/server/connect';
import type { Agent } from '@kestrel/server/model';
import type { NodeFacts } from '@kestrel/server/node-facts';
import { FOLLOW_LABEL, MIRROR_MODE_LABEL, MIRROR_MODES, PUSH_LABEL, type MirrorMode, type NodeSettingKey, type NodeSettingsValues } from '@kestrel/server/node-settings';
import { canUpdateNow, nodeUpdateLine } from '@kestrel/server/node-update';
import type { ComputerStatus } from '@kestrel/server/start-computer';
import { agoText } from '@kestrel/server/when';
import { AGENT_LABEL, AGENTS, projectName, statusText } from '../labels.ts';
import { SettingRow } from '../components/SettingRow.tsx';
import { connectActions, useConnect } from '../connectStore.ts';
import { opener, openView } from '../route.ts';
import { useComputerOffers } from '../startComputers.ts';
import { act, useApp } from '../store.ts';
import { useDraft } from '../unsaved.ts';
import { useMinuteNow } from '../useNow.ts';

/** A node's settings, as its offers record carries them (`NODE_SETTINGS`, server/src/shared/node-settings.ts). */
export type WorkerNodeSettingsValues = NodeSettingsValues;

/** The status facts the node publishes (server/src/shared/node-facts.ts). */
type WorkerNodeStatus = NodeFacts;

interface WorkerNodeSession {
  id: string;
  title: string;
  project: string;
  state: string;
}

type NodeConnection = { reachable: true } | { reachable: false; reason?: string };
type ChangeSetting = <K extends NodeSettingKey>(key: K, value: WorkerNodeSettingsValues[K]) => Promise<void>;

export interface WorkerNodeSettingsProps {
  connection: NodeConnection;
  lastHeard: string | null;
  version: string | null;
  updateLine: string | null;
  /** Why the settings cannot be changed from here though the node is reachable (it publishes none), or null. */
  note?: string | null;
  canManage: boolean;
  canUpdate: boolean;
  status: WorkerNodeStatus;
  settings: WorkerNodeSettingsValues;
  models: readonly { id: string; label: string }[];
  sessions: readonly WorkerNodeSession[];
  onBack: (newTab: boolean) => void;
  /** Reject with the reason for a refused change so the page can show it in the toast stack. */
  onChangeSetting: ChangeSetting;
  onUpdate: () => Promise<void>;
  onRestart: () => Promise<void>;
  /** The same confirmation and account action as the Devices list. */
  onRemove: () => Promise<void>;
}

const backToConnections = (newTab: boolean) => openView({ kind: 'settings', section: 'connections' }, newTab);
const NODE_AGENT_LABEL = { ...AGENT_LABEL, claude: 'Claude Code' };

function NameField({ name, disabled, onSave }: { name: string; disabled: boolean; onSave: (name: string) => Promise<boolean> }) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  let normalized: string | null = null;
  let problem: string | null = null;
  if (draft !== null) {
    try {
      normalized = deviceNameOf(draft);
      if (!normalized) problem = 'Give the worker node a name.';
    } catch (error) {
      problem = (error as Error).message;
    }
  }
  const anchor = useDraft({
    what: `the name of ${name}`,
    changed: draft !== null && normalized !== name,
    problem: disabled ? null : problem,
    blocked: disabled,
    save: async () => {
      if (!normalized || !(await onSave(normalized))) return false;
      setDraft((current) => current === draft ? null : current);
      return true;
    },
    discard: () => setDraft(null),
  });
  return (
    <SettingRow label="Name" htmlFor={id}>
      <input id={id} className="form-control" value={draft ?? name} disabled={disabled} onChange={(event) => setDraft(event.target.value)} />
      <span ref={anchor} className="draft-anchor" />
    </SettingRow>
  );
}

function NodeSwitch({ label, help, checked, disabled, onChange }: { label: string; help: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  const helpId = useId();
  return (
    <div>
      <label className="tag-rule-switch">
        <input type="checkbox" role="switch" checked={checked} disabled={disabled} aria-describedby={helpId} onChange={(event) => onChange(event.target.checked)} />
        {label}
      </label>
      <p className="settings-help" id={helpId}>{help}</p>
    </div>
  );
}

function NodeSettings({ settings, models, disabled, onChangeSetting }: Pick<WorkerNodeSettingsProps, 'settings' | 'models' | 'onChangeSetting'> & { disabled: boolean }) {
  const id = useId();
  // A refusal leaves the stored value in place and goes to the shared toast stack.
  const change = <K extends NodeSettingKey>(key: K, value: WorkerNodeSettingsValues[K]) =>
    act(async () => {
      await onChangeSetting(key, value);
      return true;
    });

  return (
    <section className="settings-section">
      <h2>Settings</h2>
      <NameField name={settings.name} disabled={disabled} onSave={async (name) => (await change('name', name)) === true} />
      <NodeSwitch label="Other devices may start sessions on this node" help="Applies to computers and phones in your Kestrel Connect account." checked={settings.remoteStarts} disabled={disabled} onChange={(value) => void change('remoteStarts', value)} />
      <fieldset className="node-defaults" disabled={disabled}>
        <legend>New sessions start with</legend>
        <p className="settings-help">These choices are preselected in New session for this node.</p>
        <SettingRow label="Agent" htmlFor={`${id}-agent`}>
          <select className="form-control" id={`${id}-agent`} value={settings.agent} onChange={(event) => void change('agent', event.target.value as Agent)}>
            {AGENTS.map((agent) => <option key={agent} value={agent}>{NODE_AGENT_LABEL[agent]}</option>)}
          </select>
        </SettingRow>
        <SettingRow label="Model" htmlFor={`${id}-model`}>
          <select className="form-control" id={`${id}-model`} value={settings.model} onChange={(event) => void change('model', event.target.value)}>
            {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
          </select>
        </SettingRow>
        <SettingRow label="Mode" htmlFor={`${id}-mode`}>
          <select className="form-control" id={`${id}-mode`} value={settings.mode} onChange={(event) => void change('mode', event.target.value === 'auto' ? 'auto' : 'ask')}>
            <option value="ask">Manual</option>
            <option value="auto">Auto</option>
          </select>
        </SettingRow>
      </fieldset>
      <NodeSwitch label="Start reviews on its own" help="The node can start reviews as requests arrive." checked={settings.autoReviews} disabled={disabled} onChange={(value) => void change('autoReviews', value)} />
      <SettingRow label="Projects" htmlFor={`${id}-projects`}>
        <select className="form-control" id={`${id}-projects`} aria-describedby={`${id}-projects-help`} value={settings.projects} disabled={disabled} onChange={(event) => void change('projects', event.target.value as MirrorMode)}>
          {MIRROR_MODES.map((mode) => <option key={mode} value={mode}>{MIRROR_MODE_LABEL[mode]}</option>)}
        </select>
        <p className="settings-help" id={`${id}-projects-help`}>Cloning ahead of time lets sessions start without waiting for Git.</p>
      </SettingRow>
      <NodeSwitch label={PUSH_LABEL} help="Sends committed work to the project’s remote at the end of a turn." checked={settings.push} disabled={disabled} onChange={(value) => void change('push', value)} />
      <NodeSwitch label={FOLLOW_LABEL} help="Updates the node when your desktops are on a newer version." checked={settings.followDesktopVersion} disabled={disabled} onChange={(value) => void change('followDesktopVersion', value)} />
    </section>
  );
}

function Status({ status }: { status: WorkerNodeStatus }) {
  const rows = [
    ...AGENTS.map((agent) => [NODE_AGENT_LABEL[agent], status.agents[agent]]),
    ['Git', status.git],
    ['Command sandbox', status.sandbox],
    ['Lingering', status.lingering],
    ['Free disk', status.freeDisk],
    ['Projects', status.projects],
  ];
  return (
    <section className="settings-section">
      <h2>Status</h2>
      <dl className="node-status">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className="settings-help">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Sessions({ sessions }: { sessions: readonly WorkerNodeSession[] }) {
  return (
    <section className="settings-section">
      <h2>Its sessions</h2>
      {sessions.length ? (
        <ul className="node-sessions">
          {sessions.map((session) => (
            <li key={session.id}>
              <div className="node-session-detail">
                <div className="trow-title" title={session.title}>{session.title}</div>
                <span className="settings-help">{session.project}</span>
              </div>
              <span className="tcell-status">{session.state}</span>
            </li>
          ))}
        </ul>
      ) : <p className="settings-help">No sessions on this node.</p>}
    </section>
  );
}

/** All displayed records and action handlers come from the container. */
export function WorkerNodeSettings({ connection, lastHeard, version, updateLine, note, canManage, canUpdate, status, settings, models, sessions, onBack, onChangeSetting, onUpdate, onRestart, onRemove }: WorkerNodeSettingsProps) {
  const disabled = !connection.reachable || !canManage;
  const reachability = connection.reachable ? 'Connected now' : `Cannot be reached${connection.reason ? ` (${connection.reason})` : ''}`;
  return (
    <>
      <div>
        <button type="button" className="secondary-button small" {...opener(onBack)}>
          <ArrowLeft aria-hidden /> Back to Connections
        </button>
      </div>
      <header className="settings-section">
        <h1>{settings.name}</h1>
        <p className="settings-help">Worker node{version && ` · Version ${version}`}</p>
        <p className="settings-help">{reachability}{lastHeard ? ` · Last heard from ${lastHeard}` : !connection.reachable && ' · Last contact unknown'}</p>
        {updateLine && <p className="settings-help">{updateLine}</p>}
        {note && <p className="settings-help">{note}</p>}
        <div className="settings-actions">
          <button type="button" className="secondary-button small" disabled={disabled || !canUpdate} onClick={() => void act(onUpdate)}>Update now</button>
          <button type="button" className="secondary-button small" disabled={disabled} onClick={() => void act(onRestart)}>Restart</button>
        </div>
      </header>
      <Status status={status} />
      <NodeSettings settings={settings} models={models} disabled={disabled} onChangeSetting={onChangeSetting} />
      <Sessions sessions={sessions} />
      <section className="settings-section">
        <h2>Account</h2>
        <button type="button" className="secondary-button small" onClick={() => void act(onRemove)}>Remove from account</button>
      </section>
    </>
  );
}

/** What the page shows before a node has published its settings: the record's own values where it has them, the defaults otherwise. */
const UNKNOWN_FACT = 'Not published yet.';
const NO_FACTS: WorkerNodeStatus = { agents: { claude: UNKNOWN_FACT, codex: UNKNOWN_FACT, opencode: UNKNOWN_FACT }, git: UNKNOWN_FACT, sandbox: UNKNOWN_FACT, lingering: UNKNOWN_FACT, freeDisk: UNKNOWN_FACT, projects: UNKNOWN_FACT };
const DEFAULT_MODEL = { id: '', label: 'Default' };
const NO_SESSIONS: readonly WorkerNodeSession[] = [];

/** Why the page cannot change anything now, or null: this computer off Kestrel Connect, or the node not answering. */
function unreachableReason(link: ConnectView['link'] | undefined, status: ComputerStatus): string | null {
  if (!link || link.state !== 'connected') return 'this computer is not connected to Kestrel Connect';
  if (status.state === 'unreachable') return status.reason;
  return null;
}

/** The node's sessions, as the workspace has them (the account's sessions that run there), one row each. */
function useNodeSessions(nodeId: string): readonly WorkerNodeSession[] {
  const sessions = useApp(useShallow((s) => (s.workspace?.sessions ?? []).filter((session) => session.runsOn === nodeId)));
  const projects = useApp((s) => s.workspace?.projects);
  return useMemo(() => (sessions.length === 0 ? NO_SESSIONS : sessions.map((session) => ({ id: session.id, title: session.title, project: projectName(session, projects ?? []), state: statusText(session) }))), [sessions, projects]);
}

/**
 * The page of a worker node of the account (`#/settings/connections/nodes/<id>`), wired to the node: every value read
 * from the store (the account's device list, the node's offers record through `useComputerOffers`, the workspace's
 * sessions), each change a request the node carries out or refuses (`node.settings.set`), and its two actions.
 */
export function WorkerNodeSettingsContainer({ nodeId }: { nodeId: string }) {
  const view = useConnect();
  const device = view?.devices.find((d) => d.id === nodeId && d.kind === 'node' && d.inAccount && !d.here) ?? null;
  const status = useComputerOffers([nodeId])(nodeId);
  const made = useApp((s) => s.machineOffers[nodeId]?.made ?? null);
  const now = useMinuteNow();
  const sessions = useNodeSessions(nodeId);
  if (!device) {
    return (
      <>
        <div>
          <button type="button" className="secondary-button small" {...opener(backToConnections)}>
            <ArrowLeft aria-hidden /> Back to Connections
          </button>
        </div>
        <p className="settings-help">That worker node is not in your account.</p>
      </>
    );
  }
  const choices = status.state === 'ready' ? status.choices : null;
  const published = choices?.node ?? null;
  const reason = unreachableReason(view?.link, status);
  const start = choices?.start;
  // The account's device list has the node's name as the service has it, which a rename from anywhere changes first.
  const settings: WorkerNodeSettingsValues = published
    ? { ...published.settings, name: device.name }
    : { ...DEFAULT_SETTINGS, name: device.name, remoteStarts: choices?.allowed ?? true, agent: start?.agent ?? 'claude', model: start?.model ?? '', mode: start?.permission === 'auto' ? 'auto' : 'ask' };
  const provider = choices?.providers.find((p) => p.agent === settings.agent);
  const listed = provider ? provider.models.map((m) => ({ id: m.id, label: m.name })) : [DEFAULT_MODEL];
  const models = listed.some((m) => m.id === settings.model) ? listed : [...listed, { id: settings.model, label: settings.model || DEFAULT_MODEL.label }];
  return (
    <WorkerNodeSettings
      key={nodeId}
      connection={reason ? { reachable: false, reason } : { reachable: true }}
      lastHeard={made === null ? null : agoText(made, now)}
      version={choices?.version ?? null}
      updateLine={nodeUpdateLine(device.name, choices?.version ?? null, choices?.update ?? null)}
      note={choices && !published ? `${device.name} runs a Kestrel that does not publish its settings, so they cannot be changed from here. Update it to change them.` : null}
      canManage={published !== null}
      canUpdate={canUpdateNow(choices?.update ?? null)}
      status={published?.facts ?? NO_FACTS}
      settings={settings}
      models={models}
      sessions={sessions}
      onBack={backToConnections}
      onChangeSetting={(key, value) => connectActions.setNodeSetting(nodeId, key, value)}
      onUpdate={() => connectActions.updateNode(nodeId)}
      onRestart={() => connectActions.restartNode(nodeId)}
      onRemove={async () => {
        if (await connectActions.removeDevice(nodeId, device.name)) backToConnections(false);
      }}
    />
  );
}

const DEFAULT_SETTINGS: WorkerNodeSettingsValues = { name: '', remoteStarts: true, agent: 'claude', model: '', mode: 'ask', autoReviews: false, projects: 'every', push: true, followDesktopVersion: true };
