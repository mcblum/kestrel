import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Folder, GitBranch, MessageSquare, Terminal } from 'lucide-react';
import type { OnboardingStep } from '@kestrel/server/onboarding';
import { reasonOf } from '@kestrel/server/sourced';
import { useResource } from '../data/resources.ts';
import { AGENTS_PATH, asAgentStatus } from '../components/useAgents.ts';
import { AGENT_LABEL } from '../labels.ts';
import { saveSetup } from './data.ts';
import { AgentStep } from './AgentStep.tsx';
import { AppearanceStep } from './AppearanceStep.tsx';
import { NotificationStep } from './NotificationStep.tsx';
import { ProjectStep } from './ProjectStep.tsx';
import { useHereProjects } from '../awayProjects.ts';

/** "A", "A and B", "A, B and C". */
const andList = (names: readonly string[]): string => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

const STEPS = ['welcome', 'appearance', 'agents', 'projects', 'notifications', 'ready'] as const;
const LABELS = ['Welcome', 'Appearance', 'Agents', 'Projects', 'Notifications', 'Ready'];
const COPY = {
  welcome: ['A home for your coding work.', 'Bring your agents and projects together. Let’s get your workspace ready.'],
  appearance: ['Pick your look.', 'Dark, light, or whatever this computer is set to. It changes as you choose, so pick the one that looks right.'],
  agents: ['Bring your agents.', 'Use Claude Code, Codex or OpenCode with the setup you already have.'],
  projects: ['What will you work on?', 'Add one project, or bring in a whole folder of them. You can always add more later.'],
  notifications: ['Know when you’re needed.', 'Leave a session working and Kestrel tells you when it finishes, fails or stops to ask you something.'],
  ready: ['Your workspace is ready.', 'Start with a task. Kestrel keeps the conversation and its work together.'],
} as const;

function Welcome() {
  return <div className="setup-welcome">
    <div className="setup-preview" aria-hidden="true">
      <div><Folder /><span>Your project</span></div>
      <div><MessageSquare /><span>A task worth building</span><span className="setup-preview-dot" /></div>
      <div><GitBranch /><span>Room to explore</span></div>
    </div>
    <div className="setup-welcome-copy"><h2>A little less juggling.</h2><p>Keep projects close, give each task its own conversation, and see where your attention is needed.</p><p>Just a few steps. Everything can be changed later.</p></div>
  </div>;
}

function Ready() {
  const projects = useHereProjects();
  const { value } = useResource(AGENTS_PATH, asAgentStatus);
  const available = value.state === 'ready' ? value.value.available : [];
  return <div className="setup-ready">
    <div className="setup-ready-row"><span className="setup-icon"><Folder aria-hidden /></span><div><h2>{projects.length ? `${projects.length} project${projects.length === 1 ? '' : 's'} ready` : 'Room for your first project'}</h2><p>{projects.length ? 'Your projects are waiting in the sidebar and on Overview.' : 'Add a project from the sidebar whenever you’re ready to work on files.'}</p></div></div>
    <div className="setup-ready-row"><span className="setup-icon"><Terminal aria-hidden /></span><div><h2>{available.length ? andList(available.map((agent) => AGENT_LABEL[agent])) : 'Connect an agent when you’re ready'}</h2><p>{available.length ? 'Ready for your first task. You can choose an agent for each session.' : 'Install and sign in to Claude Code, Codex or OpenCode before starting a session. Check availability in Settings → Connections.'}</p></div></div>
    <div className="setup-next"><MessageSquare aria-hidden /><p><strong>Next, describe what you want to build.</strong><span>Choose a project on Overview and start your first session.</span></p></div>
  </div>;
}

export function OnboardingWizard({ step }: { step: Exclude<OnboardingStep, 'complete'> }) {
  const [saving, setSaving] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectEditing, setProjectEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const index = STEPS.indexOf(step);
  const busy = saving || projectBusy;
  const go = async (next: OnboardingStep) => {
    if (busy) return;
    setSaving(true); setError(null);
    try { await saveSetup(next); } catch (e) { setError(reasonOf(e)); }
    finally { setSaving(false); }
  };
  useEffect(() => { heading.current?.focus(); setProjectEditing(false); }, [step]);
  return <div className="page column form-page setup-page">
    <div className="setup-top"><span>Make yourself at home</span><button className="quiet-button" disabled={busy} onClick={() => void go('complete')}>Skip setup</button></div>
    <ol className="setup-progress" aria-label="Setup progress">{STEPS.map((id, i) => <li key={id} className={i < index ? 'is-done' : i === index ? 'is-current' : ''} aria-current={id === step ? 'step' : undefined}><span>{i < index ? <Check aria-hidden /> : i + 1}</span>{LABELS[i]}</li>)}</ol>
    <div className="form-head"><h1 ref={heading} tabIndex={-1}>{COPY[step][0]}</h1><p className="form-lede">{COPY[step][1]}</p></div>
    <fieldset className="setup-body" disabled={saving}>
      {step === 'welcome' ? <Welcome /> : step === 'appearance' ? <AppearanceStep /> : step === 'agents' ? <AgentStep /> : step === 'projects' ? <ProjectStep onBusyChange={setProjectBusy} onEditingChange={setProjectEditing} /> : step === 'notifications' ? <NotificationStep /> : <Ready />}
    </fieldset>
    {error && <p className="field-error" role="alert">Could not save setup progress. {error} Try again.</p>}
    <div className="setup-footer">
      <span className="setup-step-count">Step {index + 1} of {STEPS.length}</span>
      <div className="form-actions">
        {index > 0 && <button className="quiet-button" disabled={busy} onClick={() => void go(STEPS[index - 1]!)}>Back</button>}
        {step === 'projects' && !projectEditing && <button className="quiet-button" disabled={busy} onClick={() => void go('notifications')}>Skip for now</button>}
        {!(step === 'projects' && projectEditing) && <button className="primary-button" disabled={busy} aria-busy={saving} onClick={() => void go(STEPS[index + 1] ?? 'complete')}>{saving ? 'Saving…' : step === 'welcome' ? 'Let’s get started' : step === 'ready' ? 'Open overview' : 'Continue'}<ArrowRight aria-hidden /></button>}
      </div>
    </div>
  </div>;
}
