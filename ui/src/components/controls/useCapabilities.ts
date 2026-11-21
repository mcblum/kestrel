// What an agent offers the controls (agents/types.ts, AgentCapabilities), held once in the app store
// and asked of the server once per agent, again until the agent itself answered (`fromSdk`). Until
// it answers, or when it cannot: the default model, every mode, no context ring.
import type { AgentCapabilities } from '@kestrel/server/agent-types';
import type { Agent } from '@kestrel/server/model';
import { PERMISSION_LEVELS } from '@kestrel/server/permissions';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { fetchResource, useResource } from '../../data/resources.ts';
import { appStore } from '../../store.ts';

const WAITING: AgentCapabilities = { models: [{ id: '', label: 'Default' }], fromSdk: false, permissions: PERMISSION_LEVELS.map((l) => l.id), contextUsage: false };

const asCapabilities = (raw: unknown): Sourced<AgentCapabilities> => ready(raw as AgentCapabilities);
const fromAgent = (caps: AgentCapabilities) => caps.fromSdk;
const pathOf = (agent: Agent) => `/api/agents/${agent}/capabilities`;

export function useCapabilities(agent: Agent): AgentCapabilities {
  const answer = useResource(pathOf(agent), asCapabilities, '', fromAgent).value;
  return answer.state === 'ready' ? answer.value : WAITING;
}

/**
 * Ask every agent what it offers before any draft needs it. A draft drawn before the answer came
 * showed "Default" and then the model it stands for, and an agent switched to for the first time
 * did the same, so a fresh Codex draft and one switched away and back drew different models
 * (matt/kestrel#14). `agents`: the ones that can start a session now (an agent that is not
 * connected has nothing to say). An agent that already answered is not asked again.
 */
export function prefetchCapabilities(agents: readonly Agent[]): void {
  for (const agent of agents) {
    const held = appStore.get().resources.get(pathOf(agent)) as Sourced<AgentCapabilities> | undefined;
    if (held?.state !== 'ready' || !fromAgent(held.value)) void fetchResource(pathOf(agent), asCapabilities);
  }
}
