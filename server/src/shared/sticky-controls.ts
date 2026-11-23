// What a new session starts with: the agent last used, and for each agent the model, effort, fast
// mode and permission mode last picked by hand on it, anywhere (a session's controls, a new-session
// draft, Settings). One remembered set per agent (0.0.17, matt/kestrel#14): a Codex pick never
// clears what was remembered for Claude, so a draft switched back to Claude lands on the last Claude
// model, and a fresh draft and a draft switched away and back draw the same thing. Only an explicit
// pick changes a set: sending a draft, or a session inheriting a mode, never does. Pure.
import { isSelectableAgent, type Agent } from '../model.ts';
import { DEFAULT_PERMISSION, isPermissionLevel, stickyPermission } from './permissions.ts';
import { DEFAULT_CONTROLS, type Controls } from './tabs.ts';

/** The controls remembered for one agent. */
export type AgentChoices = Required<Pick<Controls, 'model' | 'effort' | 'fast' | 'permission'>>;

/** What new sessions start with ("New sessions start with" in Settings → General). Persisted UI state. */
export interface Remembered {
  /** The agent a new session starts on. */
  agent: Agent;
  projectId: string | null;
  /** Each agent's last picks; an agent with none starts at its defaults. */
  byAgent: Partial<Record<Agent, AgentChoices>>;
  /** Whether a new session starts with what was used last, or always with `fixed` (Matt, 2026-11-20). Absent on older stores (read as `last`). */
  startFrom?: StartFrom;
  /**
   * The agent, model, effort, fast mode and project every new session starts with when `startFrom`
   * is `fixed`. The project is part of it (Matt, 2026-11-23: set to no project, it was changed to the
   * project last used by the next session started in one). Only the mode still follows the last used.
   */
  fixed?: FixedStart;
}

export const START_FROM = ['last', 'fixed'] as const;
export type StartFrom = (typeof START_FROM)[number];
export const START_FROM_LABEL: Record<StartFrom, string> = { last: 'What I used last', fixed: 'Always this' };
export type FixedStart = Required<Pick<Controls, 'agent' | 'model' | 'effort' | 'fast' | 'projectId'>>;
export const startFromOf = (r: Remembered): StartFrom => (r.startFrom === 'fixed' && r.fixed ? 'fixed' : 'last');

/** The controls that follow the user's last explicit choice; `agent`: the one they were picked on. */
export type StickyPick = Partial<Pick<Controls, 'model' | 'effort' | 'fast' | 'permission' | 'agent'>>;

export const DEFAULT_REMEMBERED: Remembered = { agent: DEFAULT_CONTROLS.agent, projectId: null, byAgent: {} };

/**
 * An agent's remembered set, else its defaults. An agent with nothing remembered takes the mode
 * remembered for another (the agent last used first), since a mode means the same to both (Auto is
 * Auto); never a model.
 */
export function choicesFor(r: Remembered, agent: Agent): AgentChoices {
  const own = r.byAgent[agent];
  if (own) return own;
  const mode = (r.byAgent[r.agent] ?? Object.values(r.byAgent)[0])?.permission ?? DEFAULT_PERMISSION;
  return { model: '', effort: '', fast: false, permission: mode };
}

const derived = new WeakMap<Remembered, Controls>();

/** The controls a new session starts with. The same object for the same `Remembered`, so a selector may return it. */
export function startControls(r: Remembered): Controls {
  const held = derived.get(r);
  if (held) return held;
  const fixed = startFromOf(r) === 'fixed' ? r.fixed! : null;
  const agent = fixed?.agent ?? r.agent;
  // A fixed start names the model and the project; the mode is still the one last picked on that agent.
  const controls: Controls = { ...DEFAULT_CONTROLS, agent, projectId: fixed ? fixed.projectId : r.projectId, groupId: null, ...choicesFor(r, agent), ...(fixed ? { model: fixed.model, effort: fixed.effort, fast: fixed.fast } : {}) };
  derived.set(r, controls);
  return controls;
}

/** After a pick by hand, on the agent it names. Picking a model, effort or fast mode on another agent also makes that the agent new sessions start on. Bypass is never carried over (stickyPermission). */
export function rememberPick(r: Remembered, pick: StickyPick): Remembered {
  const agent = pick.agent ?? r.agent;
  const before = choicesFor(r, agent);
  const choices: AgentChoices = {
    model: pick.model ?? before.model,
    effort: pick.effort ?? before.effort,
    fast: pick.fast ?? before.fast,
    permission: pick.permission !== undefined ? stickyPermission(pick.permission) : before.permission,
  };
  const pickedModel = pick.model !== undefined || pick.effort !== undefined || pick.fast !== undefined;
  return { ...r, agent: pickedModel ? agent : r.agent, byAgent: { ...r.byAgent, [agent]: choices } };
}

/**
 * After a draft was sent (or Settings' agent or project changed): its agent and project, with every
 * agent's picks kept as last picked, so an older draft cannot undo a later pick.
 */
export function rememberSent(sent: Pick<Controls, 'agent' | 'projectId'>, r: Remembered): Remembered {
  return sent.agent === r.agent && sent.projectId === r.projectId ? r : { ...r, agent: sent.agent, projectId: sent.projectId };
}

/** Choose whether new sessions follow the last used or a fixed start; turning `fixed` on starts from what they start with now. */
export function withStartFrom(r: Remembered, startFrom: StartFrom): Remembered {
  if (startFrom === startFromOf(r)) return r;
  const now = startControls(r);
  return { ...r, startFrom, ...(startFrom === 'fixed' ? { fixed: r.fixed ?? { agent: now.agent, model: now.model, effort: now.effort ?? '', fast: now.fast ?? false, projectId: now.projectId } } : {}) };
}

/** The fixed start replaced with these controls' agent, model, effort, fast mode and project. */
export const withFixed = (r: Remembered, controls: Pick<Controls, 'agent' | 'model' | 'effort' | 'fast' | 'projectId'>): Remembered => ({ ...r, fixed: { agent: controls.agent, model: controls.model, effort: controls.effort ?? '', fast: controls.fast ?? false, projectId: controls.projectId } });

/** Whether a pick is the user choosing this session's model, effort or fast mode themselves (so Kestrel does not move it, shared/who-does-what.ts). */
export const picksModel = (pick: StickyPick): boolean => pick.model !== undefined || pick.effort !== undefined || pick.fast !== undefined;

/** What changed between two sets of controls, among the sticky ones, with the agent they were picked on: the explicit pick to remember. */
export function pickBetween(before: Controls, after: Controls): StickyPick {
  const pick: StickyPick = {};
  if (after.model !== before.model) pick.model = after.model;
  if ((after.effort ?? '') !== (before.effort ?? '')) pick.effort = after.effort ?? '';
  if ((after.fast ?? false) !== (before.fast ?? false)) pick.fast = after.fast ?? false;
  if (after.permission !== before.permission) pick.permission = after.permission;
  return Object.keys(pick).length > 0 ? { ...pick, agent: after.agent } : pick;
}

// ---- stored shape ------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function choicesOf(raw: unknown): AgentChoices | null {
  if (!isObj(raw)) return null;
  return { model: str(raw.model), effort: str(raw.effort), fast: raw.fast === true, permission: isPermissionLevel(raw.permission) ? stickyPermission(raw.permission) : DEFAULT_PERMISSION };
}

/**
 * The remembered controls from stored UI state. Stores written before 0.0.17 hold one `lastControls`
 * (a whole Controls for the agent last used): its picks become that agent's set, once.
 */
export function storedRemembered(stored: { remembered?: unknown; lastControls?: unknown }): Remembered {
  const r = stored.remembered;
  if (isObj(r) && isSelectableAgent(r.agent)) {
    const byAgent: Partial<Record<Agent, AgentChoices>> = {};
    for (const [agent, raw] of Object.entries(isObj(r.byAgent) ? r.byAgent : {})) {
      const choices = isSelectableAgent(agent) ? choicesOf(raw) : null;
      if (choices) byAgent[agent as Agent] = choices;
    }
    const fixed = isObj(r.fixed) && isSelectableAgent(r.fixed.agent) 
      ? // A fixed start stored before it held a project keeps the project remembered then, from now on.
        { agent: r.fixed.agent, model: str(r.fixed.model), effort: str(r.fixed.effort), fast: r.fixed.fast === true, projectId: ('projectId' in r.fixed ? str(r.fixed.projectId) : str(r.projectId)) || null }
      : null;
    return { agent: r.agent, projectId: str(r.projectId) || null, byAgent, ...(fixed ? { fixed, startFrom: r.startFrom === 'fixed' ? ('fixed' as const) : ('last' as const) } : {}) };
  }
  const old = stored.lastControls;
  if (!isObj(old) || !isSelectableAgent(old.agent)) return DEFAULT_REMEMBERED;
  return { agent: old.agent, projectId: str(old.projectId) || null, byAgent: { [old.agent]: choicesOf(old)! } };
}
