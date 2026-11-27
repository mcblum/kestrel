// The agent a session runs on (Claude, Codex), first in the row, in that provider's own colour
// (styles/composer-controls.css, --provider-*): the one place brand colour is used. In a new
// session it opens a menu of the agents; in a running session it cannot change, so it is plain text.
// An agent that cannot start (not installed, signed out) is in the menu dimmed and says nothing more
// (Matt, 2026-11-26: "just dim the provider if not available"); the reason, with what to run, is in
// Settings' connections. A new session that remembered such an agent moves to the first one that can start.
import { useEffect, useRef } from 'react';
import type { MenuItem } from '@kestrel/server/menu';
import type { Agent } from '@kestrel/server/model';
import { AGENT_LABEL, AGENTS, type AgentStatus } from '../../labels.ts';
import { useAgentStatus } from '../useAgents.ts';
import { menuOpenFrom, openFrom } from './anchor.ts';

/** Until the server answers, only Claude is offered. */
const ASSUMED: AgentStatus = { available: ['claude'], notes: {}, signIn: [] };

export function agentMenu(value: Agent, status: AgentStatus): MenuItem[] {
  return AGENTS.map((a) => ({
    id: a,
    label: AGENT_LABEL[a],
    checked: a === value,
    ...(status.available.includes(a) ? {} : { disabled: true }),
  }));
}

/** The agent a new session should move to: its own cannot start now and another can. Null: stay. */
export function fallbackAgent(value: Agent, status: AgentStatus | null): Agent | null {
  if (!status || status.available.includes(value) || status.notes[value] === undefined) return null;
  return status.available[0] ?? null;
}

export function ProviderControl({ value, fixed, onChange }: { value: Agent; fixed: boolean; onChange: (agent: Agent) => void }) {
  const known = useAgentStatus(!fixed);
  const status = known ?? ASSUMED;
  const button = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const fallback = fixed ? null : fallbackAgent(value, known);
  useEffect(() => void (fallback && onChange(fallback)), [fallback]); // eslint-disable-line react-hooks/exhaustive-deps
  const className = `ctl-provider provider-${value}`;
  if (fixed) {
    return (
      <span className={`ctl ${className} ctl-fixed`} title={`Agent: ${AGENT_LABEL[value]}. A session keeps the agent it started with.`}>
        <span className="ctl-label">{AGENT_LABEL[value]}</span>
      </span>
    );
  }
  return (
    <span className={`ctl ${className}`}>
      <button
        ref={button}
        type="button"
        className="ctl-button"
        aria-haspopup="menu"
        title={`Agent: ${AGENT_LABEL[value]}. Who works on this session`}
        onPointerDown={() => void (wasOpen.current = menuOpenFrom(button.current))}
        onClick={() => {
          if (wasOpen.current) return void (wasOpen.current = false);
          openFrom(button.current!, agentMenu(value, status), (item) => item.id !== value && onChange(item.id as Agent));
        }}
      >
        <span className="ctl-label">{AGENT_LABEL[value]}</span>
      </button>
    </span>
  );
}
