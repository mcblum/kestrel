// The controls for a session, one quiet row under the message box, left-justified, the same in a
// new tab, a running session and Settings: the provider (Claude, Codex) in its own colour, the
// model with its effort, the permission mode, a ring for how full the context window is (running
// sessions only), then where it works (project, folder, environment). What a control means is in
// its tooltip. What is offered comes from the agent's capabilities: a model without effort shows
// no effort, an agent that cannot measure its context shows no ring.
// In a new tab everything is editable. In a running session the provider, project and environment
// are fixed; model, effort, fast mode and permissions can change and apply from the next message.
// A model, effort, fast mode or mode picked here is where the next new session starts (sticky-controls.ts).
// A running session on another computer of the account has the same row: its models, efforts and fast mode are the
// ones that computer published (machine-offers.ts), and its mode is Manual or Auto from here, never Bypass.
import { useEffect } from 'react';
import { Laptop } from 'lucide-react';
import { ENVIRONMENTS, showEnvironmentControl } from '@kestrel/server/environments';
import type { Agent, Project } from '@kestrel/server/model';
import { modelLabel } from '@kestrel/server/model-choice';
import { PERMISSION_LEVELS, permissionHint } from '@kestrel/server/permissions';
import { pickBetween, picksModel } from '@kestrel/server/sticky-controls';
import { switchAgent } from '@kestrel/server/model-picker';
import type { Controls } from '@kestrel/server/tabs';
import { ModePicker } from './ModePicker.tsx';
import { useApp } from '../store.ts';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { useResource } from '../data/resources.ts';
import { tabActions, tabsView } from '../tabsStore.ts';
import { ProjectPicker } from './ProjectPicker.tsx';
import { FolderPicker } from './FolderPicker.tsx';
import { ProviderControl } from './controls/ProviderControl.tsx';
import { ModelControl } from './controls/ModelControl.tsx';
import { PresetControl } from './controls/PresetControl.tsx';
import { ContextRing } from './controls/ContextRing.tsx';
import { PlanUsageReadout } from './controls/PlanUsage.tsx';
import { ComputerControl } from './controls/ComputerControl.tsx';
import { RemoteAgentControls } from './controls/RemoteAgentControls.tsx';
import { useComputerOffers, useOtherComputers } from '../startComputers.ts';
import { cloneOn, modelOptionsOf, notThereYet, projectAfterSwitch, projectOn, projectsOn, remoteBypass, remoteMode, remoteRunningModes, remoteRunningNote, REMOTE_PICKER_MODES, type ComputerStatus } from '@kestrel/server/start-computer';
import type { ModelOption } from '@kestrel/server/agent-types';
import { useMachineName } from '../machines.ts';
import { AutopilotControl } from './controls/AutopilotControl.tsx';
import { useCapabilities } from './controls/useCapabilities.ts';

/** The models an agent offers, as the model picker lists them. */
export function useModels(agent: Agent) {
  const answer = useResource(`/api/agents/${agent}/models`, asModels, '', isSettled).value;
  return answer.state === 'ready' ? answer.value.models : DEFAULT_MODELS;
}

type Models = { models: { id: string; label: string; description?: string }[]; fromSdk: boolean };
const DEFAULT_MODELS: Models['models'] = [{ id: '', label: 'Default' }];
const asModels = (raw: unknown): Sourced<Models> => {
  const r = raw as Partial<Models>;
  return ready({ models: Array.isArray(r?.models) ? r.models : DEFAULT_MODELS, fromSdk: r?.fromSdk === true });
};
/** The models are asked for once per agent while Kestrel runs. */
const isSettled = () => true;

/** What the model picker shows for a model id (the default as the model it resolves to). */
export const labelOfModel = (models: readonly { id: string; label: string; resolves?: string }[], id: string) => modelLabel(models, id);

interface Props {
  value: Controls;
  /** `new`: all editable. `running`: agent, project and environment are read-only. */
  mode: 'new' | 'running';
  onChange: (next: Controls) => void;
  /** The running session, for its context ring. */
  sessionId?: string;
  /** Offer the computer pill (a New session box); off where the choices are remembered (Settings), since a computer never is. */
  computers?: boolean;
  /** A running session on another computer of the account: that computer's id. */
  runsOn?: string;
}

/** The models a running session there offers: that computer's published menu for its agent, or its current model alone until it has one. */
function modelsThere(status: ComputerStatus, agent: Agent, model: string): readonly ModelOption[] {
  const provider = status.state === 'ready' ? status.choices.providers.find((p) => p.agent === agent) : undefined;
  return provider ? modelOptionsOf(provider.models) : [{ id: model, label: model || 'Default' }];
}

export function ComposerControls({ value, mode, onChange, sessionId, computers = true, runsOn }: Props) {
  const projects = useApp((s) => s.workspace?.projects) ?? [];
  const caps = useCapabilities(value.agent);
  const fixed = mode === 'running';
  const hasProject = value.projectId !== null;
  const projectName = projects.find((p) => p.id === value.projectId)?.name ?? 'Unscoped';
  const level = PERMISSION_LEVELS.find((l) => l.id === value.permission);
  const hint = level && permissionHint(level, value.agent);

  // A pick by hand: remembered for the next new session, then applied here.
  const pick = (next: Controls) => {
    const picked = pickBetween(value, next);
    tabActions.chooseControls(picked);
    // A model picked for a new session is that session's own: it is told so, and keeps it when it leads.
    onChange(mode === 'new' && picksModel(picked) ? { ...next, modelChosen: true } : next);
  };

  const item = (label: string, children: React.ReactNode, help?: string, kind = '') => (
    <span className={kind ? `ctl ${kind}` : 'ctl'} title={help ? `${label}: ${help}` : label} key={label}>
      {children}
    </span>
  );
  // Another computer of the account may be chosen in a new session (issue 52); its projects, agents and models then.
  const others = useOtherComputers();
  const machine = !fixed && computers && value.machine ? value.machine : null;
  const machineName = machine ? (others?.find((m) => m.id === machine)?.name ?? 'another computer') : null;
  // A running session on another computer: its row reads what that computer offers.
  const elsewhere = fixed && runsOn ? runsOn : null;
  const elsewhereName = useMachineName(elsewhere ?? undefined) ?? 'another computer';
  const offers = useComputerOffers(machine ? [machine] : elsewhere ? [elsewhere] : []);
  const status = offers(machine ?? elsewhere ?? '');
  const offered = status.state === 'ready' ? status.choices : null;
  const switchComputer = (next: string | null) => {
    const nextStatus = next ? offers(next) : null;
    const projectId = projectAfterSwitch(projects, value.projectId, next, nextStatus?.state === 'ready' ? nextStatus.choices : null);
    const { folderId: _folder, groupId: _group, ...rest } = value;
    // Back here: the agent's choices as this computer remembers them; there, that computer's (RemoteAgentControls).
    const base = next === null ? switchAgent({ ...rest, groupId: null }, value.agent, tabsView().remembered) : { ...rest, groupId: null };
    onChange({ ...base, projectId, machine: next });
  };
  // A computer no longer of the account (or one a project page named that is not): back to this one. Checked after
  // every draw with this draw's value, so it never acts on an old one; once back here it does nothing.
  const gone = machine !== null && others !== null && !others.some((m) => m.id === machine);
  useEffect(() => {
    if (gone) switchComputer(null);
  });
  const project = fixed ? (
    <span className="ctl-fixed">{projectName}</span>
  ) : (
    <ProjectPicker value={value.projectId} onSelect={(id) => onChange({ ...value, projectId: id, folderId: undefined })} {...(machine ? { projects: projectsOn(projects, machine, offered), computer: machineName ?? undefined, ...(offered ? { cloned: (p: Project) => (projectOn(p, machine) === undefined && cloneOn(p, offered) ? notThereYet(machineName ?? 'that computer') : null) } : {}) } : {})} />
  );
  const remote = (part: 'agent' | 'model') => <RemoteAgentControls part={part} agent={value.agent} model={value.model} status={status} onChange={(next) => onChange({ ...value, ...next, effort: '', fast: false, modelChosen: true })} />;
  return (
    <div className="ctl-set">
      {/* The computer first: it decides which agents and projects there are (Matt, 2026-11-26). */}
      {!fixed && computers && others && others.length > 0 && <ComputerControl value={machine} others={others} onChange={switchComputer} />}
      {machine ? remote('agent') : <ProviderControl value={value.agent} fixed={fixed} onChange={(agent) => onChange(switchAgent(value, agent, tabsView().remembered))} />}
      <span className="ctl-where">
        {item('Project', project, hasProject ? projectName : `Unscoped. No repository: it works in a scratch folder${machineName ? ` on ${machineName}` : ''} and hands changes to a project`, 'ctl-project')}
        {!fixed && !machine && <FolderPicker controls={value} onSelect={(folderId) => onChange({ ...value, folderId })} />}
        {!machine && !elsewhere && showEnvironmentControl() &&
          item(
            'Environment',
            <span className="ctl-fixed">
              <Laptop aria-hidden /> {ENVIRONMENTS[0]!.label}
            </span>,
          )}
      </span>
      {/* On the right: what the agent runs with. On the left: who runs it and where. */}
      <span className="ctl-right">
        {machine ? (
          remote('model')
        ) : elsewhere ? (
          <ModelControl models={modelsThere(status, value.agent, value.model)} value={value} running onChange={(s) => onChange({ ...value, ...s })} />
        ) : (
          <>
            <PresetControl value={value} running={fixed} onChange={pick} />
            <ModelControl models={caps.models} value={value} running={fixed} onChange={(s) => pick({ ...value, ...s })} />
          </>
        )}
        {/* Its tooltip is on the picker's own label: on this wrapper it would also show over the open menu's rows (Bypass's Enable showed the current mode's hint). */}
        <span className="ctl ctl-mode" key="Mode">
          {machine ? (
            <ModePicker value={remoteMode(value.permission, machineName ?? '').mode} levels={REMOTE_PICKER_MODES} agent={value.agent} help={remoteMode(value.permission, machineName ?? '').note ?? `Mode: Manual or Auto on ${machineName}. Bypass is chosen on the computer the session runs on`} onChange={(permission) => pick({ ...value, permission })} />
          ) : elsewhere ? (
            <ModePicker value={value.permission} levels={remoteRunningModes(caps.permissions, value.permission)} agent={value.agent} help={remoteRunningNote(value.permission, elsewhereName)} bypassRefusal={remoteBypass(elsewhereName)} onChange={(permission) => onChange({ ...value, permission })} />
          ) : (
            <ModePicker value={value.permission} levels={caps.permissions} agent={value.agent} help={`Mode: ${fixed ? `${hint}. Changes apply from your next message` : hint}`} onChange={(permission) => pick({ ...value, permission })} />
          )}
        </span>
        {fixed && sessionId && <AutopilotControl sessionId={sessionId} />}
        {/* The account's plan usage for this agent (issue 80); not in Settings' defaults, which start no session. */}
        {(fixed || computers) && <PlanUsageReadout agent={value.agent} {...(fixed && sessionId ? { sessionId } : {})} {...(elsewhere ? { elsewhere: elsewhereName } : machine ? { elsewhere: machineName ?? 'that computer' } : {})} />}
        {fixed && sessionId && caps.contextUsage && <ContextRing sessionId={sessionId} />}
      </span>
    </div>
  );
}
