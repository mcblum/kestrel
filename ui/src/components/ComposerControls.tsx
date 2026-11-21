// The controls for a session, one quiet row under the message box, left-justified, the same in a
// new tab, a running session and Settings: the provider (Claude, Codex) in its own colour, the
// model with its effort, the permission mode, a ring for how full the context window is (running
// sessions only), then where it works (project, folder, environment). What a control means is in
// its tooltip. What is offered comes from the agent's capabilities: a model without effort shows
// no effort, an agent that cannot measure its context shows no ring.
// In a new tab everything is editable. In a running session the provider, project and environment
// are fixed; model, effort, fast mode and permissions can change and apply from the next message.
// A model, effort, fast mode or mode picked here is where the next new session starts (sticky-controls.ts).
import { Laptop } from 'lucide-react';
import { ENVIRONMENTS, showEnvironmentControl } from '@kestrel/server/environments';
import type { Agent } from '@kestrel/server/model';
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
}

export function ComposerControls({ value, mode, onChange, sessionId }: Props) {
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

  const item = (label: string, children: React.ReactNode, help?: string) => (
    <span className="ctl" title={help ? `${label}: ${help}` : label} key={label}>
      {children}
    </span>
  );
  const project = fixed ? <span className="ctl-fixed">{projectName}</span> : <ProjectPicker value={value.projectId} onSelect={(id) => onChange({ ...value, projectId: id, folderId: undefined })} />;
  return (
    <div className="ctl-set">
      <ProviderControl value={value.agent} fixed={fixed} onChange={(agent) => onChange(switchAgent(value, agent, tabsView().remembered))} />
      <span className="ctl-where">
        {item('Project', project, hasProject ? undefined : 'no repository: it works in a scratch folder and hands changes to a project')}
        {!fixed && <FolderPicker controls={value} onSelect={(folderId) => onChange({ ...value, folderId })} />}
        {showEnvironmentControl() &&
          item(
            'Environment',
            <span className="ctl-fixed">
              <Laptop aria-hidden /> {ENVIRONMENTS[0]!.label}
            </span>,
          )}
      </span>
      {/* On the right: what the agent runs with. On the left: who runs it and where. */}
      <span className="ctl-right">
        <PresetControl value={value} running={fixed} onChange={pick} />
        <ModelControl models={caps.models} value={value} running={fixed} onChange={(s) => pick({ ...value, ...s })} />
        {item('Mode', <ModePicker value={value.permission} levels={caps.permissions} agent={value.agent} onChange={(permission) => pick({ ...value, permission })} />, fixed ? `${hint}. Changes apply from your next message` : hint)}
        {fixed && sessionId && caps.contextUsage && <ContextRing sessionId={sessionId} />}
      </span>
    </div>
  );
}
