// What a session shows beside its conversation that only a session has: its handoff trail (shown
// in the Details pane, details/DetailsPanel.tsx) and its sub-agents' output. The pane layout
// itself is PaneArea.tsx.
import { useEffect, useRef } from 'react';
import { ChevronRight, CircleAlert, CircleCheck, X } from 'lucide-react';
import type { TrailEntry } from '@kestrel/server/model';
import type { SubAgent } from '@kestrel/server/subagents';
import { AGENT_LABEL, dotClass, filingMark, statusText, trailStatused, UNSCOPED } from '../labels.ts';
import { FilingTag } from '../components/FilingTag.tsx';
import { opener, openSession } from '../route.ts';

// ---- handoff trail -------------------------------------------------------------------------

const VIA_LABEL = { handoff: 'handed off to', delegate: 'delegated to', fork: 'forked as' } as const;

export function Trail({ trail }: { trail: readonly TrailEntry[] }) {
  if (trail.length < 2) return <p className="muted trail-none">No handoffs. This session has stayed where it started.</p>;
  return (
    <ol className="trail">
      {trail.map((entry) => {
        const mark = filingMark(entry.filingStatus, false);
        return (
          <li key={entry.sessionId} className={entry.current ? 'current' : ''}>
            {entry.via && <span className="trail-via">{VIA_LABEL[entry.via]}</span>}
            <button className="trail-entry" disabled={entry.current} {...opener((newTab) => openSession(entry.sessionId, newTab))}>
              <span className={`status-dot ${dotClass(trailStatused(entry))}`} />
              <span>
                <strong>{entry.title}</strong>
                <small>
                  {entry.projectName ?? UNSCOPED}
                  <FilingTag mark={mark} /> · {AGENT_LABEL[entry.agent]} · {entry.current ? 'this session' : statusText(trailStatused(entry))}
                </small>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

// ---- sub-agents ----------------------------------------------------------------------------

/** What one sub-agent said and did. It cannot be messaged: it runs inside the session's agent. */
export function SubAgentView({ agent, onClose }: { agent: SubAgent | undefined; onClose: () => void }) {
  const end = useRef<HTMLPreElement>(null);
  const length = agent?.output.length ?? 0;
  useEffect(() => {
    if (end.current) end.current.scrollTop = end.current.scrollHeight;
  }, [length]);
  return (
    <div className="agent-view">
      <div className="agent-view-head">
        <span className={`status-dot ${agent?.status === 'running' ? 'working' : 'none'}`} />
        <span className="agent-view-title">{agent?.title ?? 'Sub-agent'}</span>
        <small>{!agent ? 'no longer listed' : agent.status === 'running' ? 'running' : agent.status === 'failed' ? 'failed' : 'finished'}</small>
        <button type="button" className="copy-button pane-close" aria-label="Close sub-agent output" title="Close sub-agent output" onClick={onClose}>
          <X aria-hidden />
        </button>
      </div>
      <pre ref={end}>{agent?.output || (agent?.status === 'running' ? 'Nothing yet.' : agent ? 'It reported nothing.' : 'This sub-agent is no longer listed. Its result is in the conversation.')}</pre>
    </div>
  );
}

/** The helpers this turn started, as a small card at the foot of the conversation. Click one to read it. */
export function SubAgentList({ agents, openId, onOpen }: { agents: readonly SubAgent[]; openId: string | null; onOpen: (id: string) => void }) {
  if (agents.length === 0) return null;
  return (
    <div className="agent-card" role="group" aria-label="Sub-agents">
      {agents.map((agent) => (
        <button key={agent.id} type="button" className={`agent-row${openId === agent.id ? ' selected' : ''}`} aria-pressed={openId === agent.id} onClick={() => onOpen(agent.id)}>
          {agent.status === 'running' ? <span className="working-pulse" aria-hidden /> : agent.status === 'failed' ? <CircleAlert aria-hidden /> : <CircleCheck aria-hidden />}
          <span className="agent-row-title">{agent.title}</span>
          <small>{agent.status === 'running' ? 'running' : agent.status === 'failed' ? 'failed' : ''}</small>
          <ChevronRight aria-hidden className="agent-row-open" />
        </button>
      ))}
    </div>
  );
}
