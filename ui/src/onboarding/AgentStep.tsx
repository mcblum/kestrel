import { useEffect, useState } from 'react';
import { Check, Terminal } from 'lucide-react';
import { useResource } from '../data/resources.ts';
import { AGENTS_PATH, asAgentStatus } from '../components/useAgents.ts';
import { AGENTS, AGENT_LABEL } from '../labels.ts';
import { SignIn } from '../components/SignIn.tsx';
import { startingControls, tabActions, useTabs } from '../tabsStore.ts';

export function AgentStep() {
  const { value, refresh } = useResource(AGENTS_PATH, asAgentStatus);
  const [checking, setChecking] = useState(false);
  const defaults = useTabs(startingControls);
  const status = value.state === 'ready' ? value.value : null;
  useEffect(() => {
    const first = status?.available[0];
    if (first && !status.available.includes(defaults.agent)) tabActions.setDefaults({ ...defaults, agent: first, model: '', effort: '', fast: false });
  }, [status, defaults]);
  return <div className="setup-agent-step">
    <div className="setup-agent-list">
      {AGENTS.map((agent) => {
        const available = status?.available.includes(agent) ?? false;
        return <div className="setup-agent" key={agent}>
          <span className={`setup-icon${available ? ' is-ready' : ''}`}>{available ? <Check aria-hidden /> : <Terminal aria-hidden />}</span>
          <div>
            <h2>{AGENT_LABEL[agent]}</h2>
            <p>{status ? available ? 'Ready to start a session.' : status.notes[agent] ?? 'Not available yet. Install the CLI and sign in, then check again.' : value.state === 'loading' ? 'Checking availability…' : 'Could not check availability.'}</p>
            {status?.signIn.includes(agent) && <SignIn agent={agent} />}
          </div>
          {available && <label className="setup-default">
            <input type="radio" name="setup-agent" checked={defaults.agent === agent} onChange={() => tabActions.setDefaults({ ...defaults, agent, model: '', effort: '', fast: false })} />
            Default
          </label>}
        </div>;
      })}
    </div>
    {value.state === 'unavailable' && <p className="field-error" role="alert">{value.reason}</p>}
    <div className="setup-check">
      <p className="form-note">Kestrel uses the agents installed on your computer. You can finish setup now and connect an agent later.</p>
      <button className="secondary-button" disabled={checking || value.state === 'loading'} onClick={async () => { setChecking(true); await refresh(); setChecking(false); }}>{checking ? 'Checking…' : 'Check again'}</button>
    </div>
  </div>;
}
