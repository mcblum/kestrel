// Which agents can start a session right now, asked once the server is connected.
import type { Agent } from '@kestrel/server/model';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { AGENT_LABEL, AGENTS, unavailableWords, type AgentStatus } from '../labels.ts';
import { useResource } from '../data/resources.ts';
import { useApp } from '../store.ts';

/** GET /api/agents, held once in the app store. */
export const AGENTS_PATH = '/api/agents';
/** A server from before notes sends none. */
export const asAgentStatus = (raw: unknown): Sourced<AgentStatus> => {
  const r = raw as { available?: Agent[]; notes?: AgentStatus['notes']; signIn?: Agent[] };
  return ready({ available: Array.isArray(r?.available) ? r.available : [], notes: r?.notes ?? {}, signIn: Array.isArray(r?.signIn) ? r.signIn : [] });
};

export interface ConnectionRow {
  name: string;
  connected: boolean;
  note: string;
  /** The server's full reason when an agent cannot start (what to install or run), for a tooltip. */
  detail?: string;
  /** The agent this row can sign in, when it is not signed in and Kestrel can do it from here. */
  signIn?: Agent;
}

/** Which agents can start now and why the others cannot; null until the server has answered. */
export function useAgentStatus(enabled = true): AgentStatus | null {
  const answer = useResource(enabled ? AGENTS_PATH : null, asAgentStatus).value;
  return answer.state === 'ready' && answer.value.available.length > 0 ? answer.value : null;
}

/** The server and each agent, in a fixed order, with whether it is connected. */
export function useConnections(): { live: boolean; /** False until the agents have answered. */ known: boolean; rows: ConnectionRow[] } {
  const live = useApp((s) => s.connection) === 'live';
  const answer = useResource(live ? AGENTS_PATH : null, asAgentStatus, String(live)).value;
  const status = answer.state === 'ready' ? answer.value : null;
  const agents = AGENTS.map((a: Agent) => {
    const connected = live && Boolean(status?.available.includes(a));
    if (connected) return { name: AGENT_LABEL[a], connected, note: 'Connected' };
    if (!live || !status) return { name: AGENT_LABEL[a], connected, note: 'Unknown' };
    const words = unavailableWords(status.notes[a]);
    return { name: AGENT_LABEL[a], connected, note: words[0]!.toUpperCase() + words.slice(1), detail: status.notes[a], ...(status.signIn.includes(a) ? { signIn: a } : {}) };
  });
  return { live, known: status !== null, rows: [{ name: 'Kestrel server', connected: live, note: live ? 'Connected' : 'Reconnecting…' }, ...agents] };
}
