// Which computer a New session runs on (issue 52; account-sessions.md, section 11 and "Starting a session on
// another computer, as built"). The New session box names the computer: this one by default, or another
// computer of the account, chosen per box and never remembered. What the box offers follows the computer: its
// projects, its agents and models, Manual or Auto. A start there is `session.start` on that computer, the
// phone's own operation (A8). Pure: the window and the server read the same rules.
import type { PermissionLevel } from './permissions.ts';
import type { Project } from '../model.ts';
import type { Machine } from './machines.ts';
import type { RemoteStartChoices, RemoteStartMode, RemoteStartModel, RemoteStartProject } from '../remote-starts/session-start.ts';
import type { ModelOption } from '../agents/types.ts';
import { asClone } from './machine-offers.ts';
import { BYPASS_FROM_ELSEWHERE } from './connect-ops.ts';

/** What this computer knows of whether another computer can take a session now. */
export type ComputerStatus =
  /** Not asked yet, or the answer is on its way. */
  | { state: 'asking' }
  /** It answered `session.startChoices`. */
  | { state: 'ready'; choices: RemoteStartChoices }
  /** It could not be asked, or did not answer: the reason, naming it. */
  | { state: 'unreachable'; reason: string };

/** One row of the computer menu. `id` null: this computer. `disabled`: why it cannot take a session now. */
export interface ComputerOption {
  id: string | null;
  name: string;
  disabled: string | null;
}

/** What `GET /api/start-computers/:id` answers: that computer's choices, or why it cannot be asked. */
export type StartComputerAnswer = { ok: true; choices: RemoteStartChoices } | { ok: false; reason: string };

export const statusOf = (answer: StartComputerAnswer | null): ComputerStatus => (answer === null ? { state: 'asking' } : answer.ok ? { state: 'ready', choices: answer.choices } : { state: 'unreachable', reason: answer.reason });

/** Why a computer cannot take a session now, or null when it can (or it is still being asked: sending will say). */
export function cannotStartOn(name: string, status: ComputerStatus): string | null {
  if (status.state === 'asking') return null;
  if (status.state === 'unreachable') return status.reason;
  if (!status.choices.allowed) return status.choices.refusal ?? `Starting sessions on ${name} from other devices is off in its Settings.`;
  // No provider and none missing: an older computer that lists none; it starts what its own box would.
  if (status.choices.providers.length === 0 && status.choices.missing.length > 0) return status.choices.missing[0]!.reason || `No agent can start a session on ${name} now.`;
  return null;
}

/** What the menu says beside a computer that has not answered yet; it cannot be chosen until it has. */
export const ASKING = 'Asking…';

/**
 * The menu: this computer first, then each other computer of the account by name, each disabled with its reason,
 * or with "Asking…" while it has not answered.
 */
export function computerOptions(here: string, others: readonly Machine[], status: (id: string) => ComputerStatus): ComputerOption[] {
  const reason = (m: Machine): string | null => {
    const now = status(m.id);
    return now.state === 'asking' ? ASKING : cannotStartOn(m.name, now);
  };
  return [{ id: null, name: here, disabled: null }, ...[...others].sort((a, b) => a.name.localeCompare(b.name)).map((m) => ({ id: m.id, name: m.name, disabled: reason(m) }))];
}

/**
 * The project's id on a computer (`null`: this one), or undefined when that computer does not have it. A project of
 * this computer is its own id here and, on another computer that has the same repository, that computer's id for it.
 */
export function projectOn(project: Pick<Project, 'id' | 'away' | 'alsoOn' | 'elsewhere'>, machine: string | null): string | undefined {
  if (machine === null) return project.away ? undefined : project.id;
  if (!project.away) return project.alsoOn?.find((m) => m.id === machine)?.projectId;
  return project.elsewhere?.machines.find((m) => m.id === machine)?.projectId;
}

/** The computers that have a project, other than this one, in the order it lists them. */
export function computersOf(project: Pick<Project, 'away' | 'alsoOn' | 'elsewhere'>): string[] {
  return (project.away ? (project.elsewhere?.machines ?? []).filter((m) => m.projectId !== undefined) : (project.alsoOn ?? [])).map((m) => m.id);
}

/**
 * Where a box opened on a project starts (issue 52, point 4): this computer when it has the project, else the
 * first other computer that has it and can take a session, else the first that has it (sending then says why not).
 * No project: this computer.
 */
export function defaultComputer(project: Pick<Project, 'away' | 'alsoOn' | 'elsewhere'> | null | undefined, status: (id: string) => ComputerStatus = () => ({ state: 'asking' })): string | null {
  if (!project?.away) return null;
  const there = computersOf(project);
  return there.find((id) => cannotStartOn('', status(id)) === null) ?? there[0] ?? null;
}

/**
 * The project the box keeps when the computer changes: the same project when the new computer has it too, else
 * none (the person picks one of that computer's). No project stays no project.
 */
export function projectAfterSwitch(projects: readonly Project[], projectId: string | null, machine: string | null, offers?: Pick<RemoteStartChoices, 'projects'> | null): string | null {
  if (projectId === null) return null;
  const project = projects.find((p) => p.id === projectId);
  return project && (projectOn(project, machine) !== undefined || (machine !== null && cloneOn(project, offers) !== undefined)) ? projectId : null;
}

/**
 * The projects a computer has, as this computer lists them, and (with its offers) those it would clone when a session
 * starts: the ones the box offers when it is chosen.
 */
export function projectsOn(projects: readonly Project[], machine: string | null, offers?: Pick<RemoteStartChoices, 'projects'> | null): Project[] {
  return projects.filter((p) => projectOn(p, machine) !== undefined || (machine !== null && cloneOn(p, offers) !== undefined));
}

/**
 * The mode a session started on another computer starts in (A8: Manual or Auto, never Bypass), and what the box
 * says when it is not the mode chosen here. Bypass becomes Auto; a mode another computer does not take from here
 * (Accept edits, Plan, Read only) becomes Manual, the one that asks before anything.
 */
export function remoteMode(permission: PermissionLevel, name: string): { mode: RemoteStartMode; note: string | null } {
  if (permission === 'ask' || permission === 'auto') return { mode: permission, note: null };
  if (permission === 'bypass') return { mode: 'auto', note: `${BYPASS_FROM_ELSEWHERE} This session starts in Auto on ${name}.` };
  return { mode: 'ask', note: `A session on ${name} starts in Manual or Auto from here. This one starts in Manual.` };
}

/**
 * What a computer offers to clone that is this project (a worker node, item 64), or undefined: an entry marked
 * `clone` whose ids include this project's id here or its id on a computer that has it.
 */
export function cloneOn(project: Pick<Project, 'id' | 'away' | 'alsoOn' | 'elsewhere'>, offers: Pick<RemoteStartChoices, 'projects'> | null | undefined): RemoteStartProject | undefined {
  if (!offers) return undefined;
  const ids = new Set([project.id, ...(project.alsoOn ?? []).map((m) => m.projectId), ...(project.elsewhere?.machines ?? []).flatMap((m) => m.projectId ?? [])]);
  return offers.projects.find((p) => p.clone?.of.some((id) => ids.has(id)));
}

/** A computer that does not have the project and does not clone it on demand (a desktop; account-sessions.md 10.2). */
export const doesNotHave = (name: string, project: string): string => `${name} does not have ${project}. Clone it there first, or pick a project it has.`;

/** Under a project the computer chosen does not have yet but clones when the session starts. */
export const notThereYet = (name: string): string => `Not on ${name} yet; it is cloned when the session starts.`;

/** What the New session box says while a start waits for the other computer's answer. */
export const startingOn = (name: string): string => `Starting on ${name}…`;

/** A start that got no answer in time, even asked again: it may have happened there (item 81). */
export const startMayHaveHappened = (name: string): string => `${name} did not answer in time. If the session started there it will show in the sidebar.`;

/** The modes the box's mode picker offers while another computer is chosen. */
export const REMOTE_PICKER_MODES: readonly PermissionLevel[] = ['ask', 'auto'];

/**
 * The modes a running session on another computer offers from here (Matt, 2026-11-27, issue 79: "why not just allow the
 * user to see / change as if it were local?"): every mode its agent understands, as a session here offers, Bypass
 * included so its row shows; Bypass itself is never switched on from here (`remoteBypass`), and a session already in
 * Bypass there shows it ticked and may be changed away from it. `levels`: the agent's own (its capabilities).
 */
export function remoteRunningModes(levels: readonly PermissionLevel[], permission: PermissionLevel): readonly PermissionLevel[] {
  return levels.includes(permission) ? levels : [...levels, permission];
}

/** Why the Bypass row of a running session on another computer has no Enable: where it is chosen. */
export const remoteBypass = (name: string): string => `Bypass is chosen on ${name}, the computer the session runs on.`;

/** The mode picker's words for a running session on `name`. */
export function remoteRunningNote(permission: PermissionLevel, name: string): string {
  if (permission === 'bypass') return `Mode: Bypass on ${name}. ${BYPASS_FROM_ELSEWHERE} Another mode can be chosen here, from your next message`;
  return `Mode, on ${name}: changes apply from your next message. ${BYPASS_FROM_ELSEWHERE}`;
}

/** A model menu as another computer published it (machine-offers.ts), in the shape the model picker reads. */
export function modelOptionsOf(models: readonly RemoteStartModel[]): ModelOption[] {
  return models.map((m) => ({ id: m.id, label: m.name, ...(m.efforts ? { efforts: m.efforts } : {}), ...(m.fast ? { fast: true } : {}) }));
}

/** Why a computer is listed but cannot take a session from here now: it did not answer. */
export const unreachableStart = (name: string): string => `${name} cannot be reached now.`;

const AGENT_IDS = ['claude', 'codex', 'opencode'] as const;
const obj = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const agentOf = (value: unknown): RemoteStartChoices['agents'][number] | null => (AGENT_IDS.includes(value as never) ? (value as RemoteStartChoices['agents'][number]) : null);

function providerOf(raw: unknown): RemoteStartChoices['providers'][number] | null {
  const r = obj(raw);
  const agent = r && agentOf(r.agent);
  if (!r || !agent || !Array.isArray(r.models)) return null;
  const models = r.models.flatMap((m) => {
    const o = obj(m);
    const id = o && str(o.id);
    return o && id !== null ? [{ id, name: str(o.name) || id || 'Default', ...(o.more === true ? { more: true as const } : {}) }] : [];
  });
  if (models.length === 0) return null;
  const preferred = str(r.default);
  return { agent, name: str(r.name) ?? agent, models, default: preferred !== null && models.some((m) => m.id === preferred) ? preferred : models[0]!.id };
}

/**
 * What another computer answered to `session.startChoices`, as this computer uses it, or null when it is not one. It
 * is sealed under the account key but still outside data: read here and nowhere else. A computer that answers no
 * `providers` (older) offers what its box would start with and nothing to pick.
 */
export function asStartChoices(raw: unknown): RemoteStartChoices | null {
  const r = obj(raw);
  const start = r && obj(r.start);
  const startAgent = start && agentOf(start.agent);
  if (!r || typeof r.allowed !== 'boolean' || !start || !startAgent) return null;
  const permission = start.permission === 'auto' ? 'auto' : 'ask';
  return {
    here: str(r.here) ?? 'that computer',
    allowed: r.allowed,
    ...(str(r.refusal) ? { refusal: str(r.refusal)! } : {}),
    agents: Array.isArray(r.agents) ? r.agents.flatMap((a) => agentOf(a) ?? []) : [],
    presets: [],
    start: { agent: startAgent, model: str(start.model) ?? '', effort: str(start.effort) ?? '', fast: start.fast === true, permission },
    providers: Array.isArray(r.providers) ? r.providers.flatMap((p) => providerOf(p) ?? []) : [],
    missing: Array.isArray(r.missing)
      ? r.missing.flatMap((m) => {
          const o = obj(m);
          const agent = o && agentOf(o.agent);
          return o && agent ? [{ agent, name: str(o.name) ?? agent, reason: str(o.reason)?.trim() || `${str(o.name) ?? agent} cannot start a session on ${str(r.here) ?? 'that computer'} now.` }] : [];
        })
      : [],
    // An older computer answers no projects: the account's own project records say what it has.
    projects: Array.isArray(r.projects)
      ? r.projects.flatMap((p) => {
          const o = obj(p);
          const id = o && str(o.id);
          if (!o || !id) return [];
          const folders = Array.isArray(o.folders) ? o.folders.flatMap((f) => ((x) => (x && str(x.id) ? [{ id: str(x.id)!, name: str(x.name) ?? '' }] : []))(obj(f))) : [];
          const chosen = str(o.defaultFolderId);
          const clone = asClone(o.clone);
          return [{ id, name: str(o.name) ?? 'Project', folders, defaultFolderId: chosen !== null && folders.some((f) => f.id === chosen) ? chosen : null, ...(clone ? { clone } : {}) }];
        })
      : [],
  };
}
export type { RemoteStartChoices, RemoteStartProvider } from '../remote-starts/session-start.ts';
