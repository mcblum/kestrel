// Whether an agent can run on a worker node comes from asking it, never from a credential being there (docs/spike-
// results.md, "Worker nodes", point 6: OpenCode was signed in and its provider refused every turn). Asking it whether
// it is signed in costs nothing; whether its provider will take a turn is only known from a turn. So a turn that
// failed for a reason that lasts (the sign-in ended, the usage is used up) is remembered for that agent, and the node
// says so until a turn of it succeeds or the person signs it in again (`kestrel node agents`). A failure that passes
// (a rate limit, a network error) is not remembered. Kept in memory: a restart asks the agents afresh.
import type { AgentEvent, AvailabilityAnswer } from '../agents/types.ts';
import type { Agent } from '../model.ts';
import type { KestrelKind } from '../shared/host-kind.ts';
import { isDataVersionFailure, nodeAgentReason, type AgentTrouble, type NodeAgentProblem } from '../shared/node-agents.ts';

type Failed = Extract<AgentEvent, { type: 'failed' }>;

/** A provider saying the account's usage is spent, in the words providers use. A rate limit passes and is not this. */
const OUT_OF_USAGE = /usage (limit|exceeded)|exceeded .{0,40}(usage|quota)|insufficient[_ ]quota|out of (credits|usage)|credit balance|billing|quota exceeded/i;
/** The program could not be found or run: our own sentences for it (agents/*\/process.ts, claude/failure.ts). */
const MISSING = /\bis not installed\b|could not run Claude Code/i;

/** The lasting reason a turn failed, or null when it is one that passes. Pure. */
export function lastingTrouble(event: Pick<Failed, 'reason' | 'kind'>): AgentTrouble | null {
  if (event.kind === 'auth') return 'signed-out';
  if (isDataVersionFailure(event.reason)) return 'data-version';
  if (MISSING.test(event.reason)) return 'missing';
  if (OUT_OF_USAGE.test(event.reason)) return 'out-of-usage';
  return null;
}

export interface RememberedTrouble {
  trouble: AgentTrouble;
  /** The agent's own words, for `out-of-usage`. */
  detail: string;
}

/** What each agent's last failed turn said, while it lasts. */
export class AgentTroubles {
  private readonly held = new Map<Agent, RememberedTrouble>();

  /** A turn failed: remembered when the reason lasts. True when what is remembered changed. */
  failed(agent: Agent, event: Pick<Failed, 'reason' | 'kind'>): boolean {
    const trouble = lastingTrouble(event);
    if (!trouble) return false;
    const before = this.held.get(agent);
    this.held.set(agent, { trouble, detail: event.reason });
    return before?.trouble !== trouble || before.detail !== event.reason;
  }

  /** A turn of it succeeded, or the person signed it in again: forgotten. True when something was. */
  forget(agent: Agent): boolean {
    return this.held.delete(agent);
  }

  of(agent: Agent): RememberedTrouble | null {
    return this.held.get(agent) ?? null;
  }
}

/** Which kind of server this is and what other devices call it: a node words its agents for itself. */
export interface AgentsWhere {
  kind: KestrelKind;
  name: string;
  /** Where OpenCode's database is, as the node's terminal would type it, for `data-version` (one-at-a-time.ts names it). */
  opencodeDatabase?: string;
}

/** What other devices read about a node's agent: the node's name. */
const elsewhere = (where: AgentsWhere) => ({ elsewhere: where.name });

/** Why an agent cannot run on a node, as a value, from its adapter's answer and what its last turn left. Pure. */
export function nodeProblemOf(answer: AvailabilityAnswer, remembered: RememberedTrouble | null, database?: string): NodeAgentProblem | null {
  const where = database ? { database } : {};
  if (!answer.available) {
    if (answer.problem === 'missing') return { trouble: 'missing' };
    if (answer.problem === 'auth') return { trouble: 'signed-out' };
    if (isDataVersionFailure(answer.reason ?? '')) return { trouble: 'data-version', ...where };
    return { trouble: 'other', detail: answer.reason ?? '' };
  }
  if (!remembered) return null;
  return remembered.trouble === 'data-version' ? { trouble: 'data-version', ...where } : { trouble: remembered.trouble, detail: remembered.detail };
}

/**
 * What an agent's availability answer says here. In the app, the adapter's own answer, unchanged. On a node, in the
 * node's words for other devices (shared/node-agents.ts), with the reason as a value (`nodeProblem`) so the node's own
 * terminal can word it for itself; and a remembered lasting refusal counts against an agent that otherwise answers that
 * it can start. A node has no Sign in button, so `signIn` is never offered there. Pure.
 */
export function availabilityHere(agent: Agent, answer: AvailabilityAnswer, remembered: RememberedTrouble | null, where: AgentsWhere): AvailabilityAnswer {
  if (where.kind !== 'node') return answer;
  const problem = nodeProblemOf(answer, remembered, where.opencodeDatabase);
  if (!problem) return answer;
  const kind = problem.trouble === 'missing' ? 'missing' : problem.trouble === 'signed-out' ? 'auth' : undefined;
  return { available: false, reason: nodeAgentReason(agent, problem, elsewhere(where)), ...(kind ? { problem: kind } : {}), nodeProblem: problem };
}

/** A failed turn as the session shows it: in the app unchanged; on a node, a lasting reason in the node's words. Pure. */
export function failedHere(agent: Agent, event: Failed, where: AgentsWhere): Failed {
  if (where.kind !== 'node') return event;
  const trouble = lastingTrouble(event);
  if (!trouble) return event;
  const problem: NodeAgentProblem = trouble === 'data-version' ? { trouble, ...(where.opencodeDatabase ? { database: where.opencodeDatabase } : {}) } : { trouble, detail: event.reason };
  return { ...event, reason: nodeAgentReason(agent, problem, elsewhere(where)) };
}
