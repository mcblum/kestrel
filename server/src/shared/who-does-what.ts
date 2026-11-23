// Model presets and who does what (0.0.20, matt/kestrel#18 and #25). A preset is a named agent,
// model, effort and fast mode, saved once and picked from the controls under the message box. The
// "Who does what" table points each role (Design, Build, Review) at a preset, and carries a few
// lines of the user's own on who should do what; the Review role is the separate review model.
// One stored record, app-wide. Pure and browser-safe: the rules and the words.
import { AGENT_LABEL, isSelectableAgent, type Agent } from '../model.ts';
import { effortLabel } from './model-choice.ts';
import type { Controls } from './tabs.ts';

export interface ModelPreset {
  id: string;
  name: string;
  agent: Agent;
  /** The agent's model id; '' for its default. */
  model: string;
  /** '' for the model's default. */
  effort: string;
  fast: boolean;
}

export const ROLES = ['design', 'build', 'review'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABEL: Record<Role, string> = { design: 'Design', build: 'Build', review: 'Review' };
export const ROLE_HELP: Record<Role, string> = {
  design: 'Visual work: layout, styling, a component’s look',
  build: 'Implementation: wiring a design in, logic, tests',
  review: 'Reviewing another agent’s work before a pull request',
};

export interface WhoDoesWhat {
  presets: ModelPreset[];
  /** The preset each role runs on; null leaves the role to the session's own agent. */
  roles: Record<Role, string | null>;
  /** The user's own words on who should do what, given to every agent. */
  instruction: string;
  /**
   * Who may review, in order of preference (preset ids). The one used is the first that did not write
   * the work (`pickReviewer`): whoever wrote the code does not review it (Matt, 2026-11-20).
   * `roles.review` is always the first of these. Absent on older records (read as `roles.review` alone).
   */
  reviewers?: string[];
  /** Offer a review when a pull request is created (Matt, 2026-11-20); "Don't ask again" turns it off. Absent on older records (read as on). */
  reviewOffer?: boolean;
  /**
   * Reviews start on their own (Matt, 2026-11-23): when a session's agent opens a pull request or asks
   * for a review of its work, the review starts without the question. Off unless the user chose it,
   * from the offer's "Always start reviews" or in Settings. Absent on older records (read as off).
   */
  reviewAuto?: boolean;
  /** How each role's work is sent: by itself, only after the user approves, or not at all. Absent on records stored before it existed (read as `auto`). */
  modes?: Record<Role, RoleMode>;
  /**
   * Who a role's work goes to when its first choice cannot run (not connected, not signed in, out
   * of usage), in order of preference (preset ids), for Design and Build; Review has `reviewers`.
   * Absent on older records (read as none).
   */
  fallbacks?: Partial<Record<Role, string[]>>;
  /** What happens then: the user is asked first (the default), or the next one is used and they are told. */
  whenUnavailable?: Unavailable;
  /**
   * The preset a session moves to once it leads other sessions (Matt, 2026-11-20): Orchestrate sits
   * above Design and Build, and Review apart. Not a role `delegate` takes: the orchestrator is the
   * session the user typed in. Null or absent leaves a lead on the model it has.
   */
  orchestrate?: string | null;
  /**
   * Who may orchestrate, in order of preference (preset ids): a lead moves to the first on its own
   * agent, since a session keeps its agent. `orchestrate` is always the first of these. Absent on
   * older records (read as `orchestrate` alone).
   */
  orchestrators?: string[];
}

export const UNAVAILABLE = ['ask', 'auto'] as const;
export type Unavailable = (typeof UNAVAILABLE)[number];
export const UNAVAILABLE_LABEL: Record<Unavailable, string> = { ask: 'Ask me first', auto: 'Use the next one and tell me' };
export const whenUnavailable = (who: WhoDoesWhat): Unavailable => who.whenUnavailable ?? 'ask';
export const MAX_FALLBACKS = 3;
/** The roles `delegate` hands out that take a fallback order of their own. */
export const FALLBACK_ROLES = ['design', 'build'] as const satisfies readonly Role[];
export const ORCHESTRATE_LABEL = 'Orchestrate';
export const ORCHESTRATE_HELP = 'Leading the work: splitting a task, handing parts to Design and Build, and putting the results together';

export const ROLE_MODES = ['auto', 'ask', 'off'] as const;
export type RoleMode = (typeof ROLE_MODES)[number];
export const ROLE_MODE_LABEL: Record<RoleMode, string> = { auto: 'Route automatically', ask: 'Ask me first', off: 'Off' };
/** The second line under each: what it does, in a few words. */
export const ROLE_MODE_DETAIL: Record<RoleMode, string> = { auto: 'No prompt in Auto or Bypass', ask: 'Always shows a card to approve', off: 'Keeps the list, sends nothing' };
export const modeOfRole = (who: WhoDoesWhat, role: Role): RoleMode => who.modes?.[role] ?? 'auto';

export const NOBODY: WhoDoesWhat = { presets: [], roles: { design: null, build: null, review: null }, reviewers: [], modes: { design: 'auto', build: 'auto', review: 'auto' }, fallbacks: { design: [], build: [] }, whenUnavailable: 'ask', orchestrate: null, orchestrators: [], reviewOffer: true, instruction: '' };
export const MAX_PRESETS = 12;
export const MAX_REVIEWERS = 4;
export const MAX_PRESET_NAME = 30;
export const MAX_ROLE_INSTRUCTION = 2000;
const MAX_ID = 200;

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** Why one preset cannot be saved, or null when it can. */
export function presetProblem(value: unknown): string | null {
  const v = obj(value);
  const name = str(v.name);
  if (!name) return 'Give every preset a name.';
  if (name.length > MAX_PRESET_NAME) return `"${name.slice(0, 20)}…": a name can be at most ${MAX_PRESET_NAME} characters.`;
  if (!isSelectableAgent(v.agent)) return `${name}: pick the agent it runs on.`;
  if (typeof v.model !== 'string' || v.model.length > MAX_ID || typeof v.effort !== 'string' || v.effort.length > MAX_ID) return `${name}: its model or effort cannot be read.`;
  return null;
}

/** Why this cannot be the stored record, or null when it can. `value` is what a client sent. */
export function whoDoesWhatProblem(value: unknown): string | null {
  const v = obj(value);
  if (!Array.isArray(v.presets)) return 'Send the presets as a list.';
  if (v.presets.length > MAX_PRESETS) return `There can be at most ${MAX_PRESETS} presets.`;
  const problem = v.presets.map(presetProblem).find((p) => p !== null);
  if (problem) return problem;
  const names = v.presets.map((p) => str(obj(p).name).toLowerCase());
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice) return `Two presets are called "${twice}". Give each its own name.`;
  if (typeof v.instruction !== 'string') return 'Send the instruction as text; empty for none.';
  if (v.instruction.length > MAX_ROLE_INSTRUCTION) return `The instruction can be at most ${MAX_ROLE_INSTRUCTION} characters.`;
  return null;
}

/** A record that passed `whoDoesWhatProblem`, as stored: a new preset gets an id, and a role whose preset is gone points at nothing. */
export function cleanWhoDoesWhat(value: unknown, newId: () => string): WhoDoesWhat {
  const v = obj(value);
  const presets: ModelPreset[] = (Array.isArray(v.presets) ? v.presets : []).map((raw) => {
    const p = obj(raw);
    const id = str(p.id);
    return { id: id && id.length <= 80 ? id : newId(), name: str(p.name), agent: p.agent as Agent, model: str(p.model), effort: str(p.effort), fast: p.fast === true };
  });
  const ids = new Set(presets.map((p) => p.id));
  const chosen = obj(v.roles);
  const role = (r: Role): string | null => (typeof chosen[r] === 'string' && ids.has(chosen[r] as string) ? (chosen[r] as string) : null);
  // The reviewers in order, each once; a record from before there were several has the one in `roles.review`.
  const listed = Array.isArray(v.reviewers) ? v.reviewers : [chosen.review];
  const reviewers = [...new Set(listed.filter((id): id is string => typeof id === 'string' && ids.has(id)))].slice(0, MAX_REVIEWERS);
  const modes = obj(v.modes);
  const mode = (r: Role): RoleMode => ((ROLE_MODES as readonly unknown[]).includes(modes[r]) ? (modes[r] as RoleMode) : 'auto');
  // A role's fallbacks: each once, never its first choice, and none for a role left to the session.
  const given = obj(v.fallbacks);
  const after = (r: Role): string[] => (role(r) === null || !Array.isArray(given[r]) ? [] : [...new Set((given[r] as unknown[]).filter((id): id is string => typeof id === 'string' && ids.has(id) && id !== role(r)))].slice(0, MAX_FALLBACKS));
  const leads = Array.isArray(v.orchestrators) ? v.orchestrators : [v.orchestrate];
  const orchestrators = [...new Set(leads.filter((id): id is string => typeof id === 'string' && ids.has(id)))].slice(0, MAX_REVIEWERS);
  const orchestrate = orchestrators[0] ?? null;
  return { presets, roles: { design: role('design'), build: role('build'), review: reviewers[0] ?? null }, reviewers, modes: { design: mode('design'), build: mode('build'), review: mode('review') }, fallbacks: { design: after('design'), build: after('build') }, whenUnavailable: v.whenUnavailable === 'auto' ? 'auto' : 'ask', orchestrate, orchestrators, reviewOffer: v.reviewOffer !== false, ...(v.reviewAuto === true ? { reviewAuto: true } : {}), instruction: typeof v.instruction === 'string' ? v.instruction.trim().slice(0, MAX_ROLE_INSTRUCTION) : '' };
}

/** The stored record as read back: presets that cannot be read are dropped. */
export function sanitizeWhoDoesWhat(value: unknown): WhoDoesWhat {
  const v = obj(value);
  const presets = (Array.isArray(v.presets) ? v.presets : []).filter((p) => presetProblem(p) === null && str(obj(p).id) !== '').slice(0, MAX_PRESETS);
  return cleanWhoDoesWhat({ ...v, presets }, () => '');
}

/** The preset a role runs on, or null when the role is left to the session's own agent. */
export const presetForRole = (who: WhoDoesWhat, role: Role): ModelPreset | null => (modeOfRole(who, role) === 'off' ? null : (who.presets.find((p) => p.id === who.roles[role]) ?? null));

/** "Codex · gpt-6.2-astra · High": what a preset is, where a model's own label is not at hand. */
export function presetSummary(preset: Pick<ModelPreset, 'agent' | 'model' | 'effort' | 'fast'>, modelName?: string): string {
  const effort = preset.effort ? preset.effort.charAt(0).toUpperCase() + preset.effort.slice(1) : '';
  return [AGENT_LABEL[preset.agent], modelName ?? (preset.model || 'Default model'), effort, preset.fast ? 'Fast' : ''].filter(Boolean).join(' · ');
}

/** The controls with a preset applied: its agent, model, effort and fast mode; everything else stays. */
export const applyPreset = (controls: Controls, preset: ModelPreset): Controls => ({ ...controls, agent: preset.agent, model: preset.model, effort: preset.effort, fast: preset.fast });

/** The preset the controls now match exactly, if any: what the preset control shows as chosen. */
export const matchingPreset = (presets: readonly ModelPreset[], controls: Pick<Controls, 'agent' | 'model' | 'effort' | 'fast'>): ModelPreset | undefined =>
  presets.find((p) => p.agent === controls.agent && p.model === controls.model && p.effort === (controls.effort ?? '') && p.fast === (controls.fast ?? false));

/** A new preset from what the controls hold now. */
export const presetFrom = (name: string, controls: Pick<Controls, 'agent' | 'model' | 'effort' | 'fast'>): Omit<ModelPreset, 'id'> => ({ name, agent: controls.agent, model: controls.model, effort: controls.effort ?? '', fast: controls.fast ?? false });

/** Whether the Create pull request form offers a review: someone is set to review, and the user has not said "Don't ask again". */
export const offersReview = (who: WhoDoesWhat): boolean => who.reviewOffer !== false && presetForRole(who, 'review') !== null;

/** Whether a review starts without the question: the user chose it, and someone is set to review. */
export const startsReviewAlone = (who: WhoDoesWhat): boolean => who.reviewAuto === true && presetForRole(who, 'review') !== null;

/** Who wrote some of the work under review: an agent and the model it ran on ('' for its default). */
export interface Author {
  agent: Agent;
  model: string;
}

/** The presets that may review, in the user's order; none when the Review role is off. */
export const reviewersOf = (who: WhoDoesWhat): ModelPreset[] => (modeOfRole(who, 'review') === 'off' ? [] : (who.reviewers ?? (who.roles.review ? [who.roles.review] : [])).flatMap((id) => who.presets.filter((p) => p.id === id)));

/**
 * The reviewer for work these authors wrote: whoever wrote the code does not review it. The first
 * reviewer on another agent than every author; failing that, the first on another model than every
 * author on its agent. Null when every reviewer wrote some of it.
 */
export function pickReviewer(reviewers: readonly ModelPreset[], authors: readonly Author[]): ModelPreset | null {
  const otherAgent = reviewers.find((r) => authors.every((a) => a.agent !== r.agent));
  return otherAgent ?? reviewers.find((r) => authors.every((a) => a.agent !== r.agent || a.model !== r.model)) ?? null;
}

/** Why nobody can review this work, when someone is set to: every reviewer wrote some of it. */
export function noReviewerReason(reviewers: readonly ModelPreset[], authors: readonly Author[]): string {
  if (reviewers.length === 0) return 'No agent is set to review. Choose one in Settings → Models & roles → Who does what.';
  const wrote = [...new Set(authors.map((a) => `${AGENT_LABEL[a.agent]}${a.model ? ` (${a.model})` : ''}`))].join(' and ');
  return `This work was written by ${wrote}, and ${reviewers.length === 1 ? `the only reviewer set, "${reviewers[0]!.name}", is the same` : 'every reviewer set is one of them'}. Whoever wrote the code does not review it: add another reviewer, on a different agent or model, in Settings → Models & roles → Who does what.`;
}

/**
 * A preset in full, for its second line in a menu or a list: the agent, the model by the name its
 * agent gives it ("Sonnet 5.5", not "sonnet"), and the effort, said even when it is the model's own.
 */
export function presetDetail(preset: Pick<ModelPreset, 'agent' | 'effort' | 'fast'>, modelName: string): string {
  return [AGENT_LABEL[preset.agent], modelName, preset.effort ? `${effortLabel(preset.effort)} effort` : 'Default effort', preset.fast ? 'Fast' : ''].filter(Boolean).join(' · ');
}

/**
 * Presets most people want, by name only: offered in Settings → Model presets to start from, each
 * waiting for the user to choose its agent and model (Matt, 2026-11-20). Nothing is saved for one
 * until a model is chosen for it.
 */
export const STARTER_PRESETS: readonly string[] = ['Everyday coding', 'Complex multi-step coding', 'Orchestration and deep logic', 'Design and visual work', 'Adversarial review'];

/** The starters not already there by name, in order. */
export const missingStarters = (names: readonly string[]): string[] => STARTER_PRESETS.filter((starter) => !names.some((name) => name.trim().toLowerCase() === starter.toLowerCase()));

// ---- when a role's first choice cannot run ---------------------------------------------------

/** Everyone a role's work may go to, first choice first; none when the role is off or left to the session. Review's are its reviewers. */
export function runnersOf(who: WhoDoesWhat, role: Role): ModelPreset[] {
  if (role === 'review') return reviewersOf(who);
  const first = presetForRole(who, role);
  if (!first) return [];
  return [first, ...(who.fallbacks?.[role] ?? []).flatMap((id) => who.presets.filter((p) => p.id === id && p.id !== first.id))];
}

/** The first of `runners` not tried yet whose agent can run now; null when there is none. */
export const nextRunner = (runners: readonly ModelPreset[], tried: readonly string[], available: readonly Agent[]): ModelPreset | null => runners.find((p) => !tried.includes(p.id) && available.includes(p.agent)) ?? null;

/**
 * Whether a failure says the agent cannot go on for now on this account or model: out of usage,
 * rate limited, out of credit or quota, or not signed in (`kind: 'auth'`, said by the caller). Read
 * from the agent's own words, which differ by agent; anything else (a crash, a bad request) is
 * not a reason to give the work to someone else.
 */
export function cannotRunNow(reason: string): boolean {
  return /usage limit|rate.?limit|limit reached|too many requests|\b429\b|quota|out of (usage|credits?|tokens)|insufficient (credits?|quota|balance)|credit balance|billing|overloaded|not signed in|sign in again|unauthori[sz]ed|\b401\b|log ?in again|authenticat/i.test(reason);
}

/** A role's work in flight: what was asked and who has been tried, so it can be given to the next. Stored with the session. */
export interface RoleRun {
  role: Role;
  /** The task as it was given, without anything Kestrel put before it. */
  brief: string;
  /** Preset ids already tried, this session's own last. */
  tried: string[];
}

export function sanitizeRoleRun(value: unknown): RoleRun | null {
  const v = obj(value);
  if (!(ROLES as readonly unknown[]).includes(v.role) || typeof v.brief !== 'string' || !Array.isArray(v.tried)) return null;
  return { role: v.role as Role, brief: v.brief, tried: v.tried.filter((id): id is string => typeof id === 'string') };
}

const named = (preset: ModelPreset): string => `"${preset.name}" (${presetSummary(preset)})`;

/** The card that asks before a role's work goes to its next choice. */
export const fallbackAsk = (role: Role, from: ModelPreset, why: string, to: ModelPreset): { title: string; body: string } => ({
  title: `${ROLE_LABEL[role]} cannot run on "${from.name}"`,
  body: `${named(from)} ${why}. Next in your order for ${ROLE_LABEL[role]} is ${named(to)}. Use it for this part, or leave the part where it is?`,
});

/** What the user is told when a role's work went to its next choice. */
export const fallbackNotice = (role: Role, from: ModelPreset, why: string, to: ModelPreset, inPlace: boolean): string =>
  `${ROLE_LABEL[role]}: ${named(from)} ${why}, so ${inPlace ? 'the same session carries on with' : 'this part was given to'} ${named(to)}. Change the order in Settings → Models & roles → Who does what.`;

/** What a session is told when the part it handed out was moved to another runner, so it keeps waiting on the right one. */
export const fallbackTold = (role: Role, title: string, from: ModelPreset, why: string, to: ModelPreset, newId: string | null): string =>
  `The ${ROLE_LABEL[role]} part "${title}" could not go on: ${named(from)} ${why}. Kestrel gave it to ${named(to)}${newId ? `, as a new session (${newId})` : ', in the same session'}. Do not do that part yourself; you are told when it finishes.`;

/** What is added to a failure report when there was nobody else to give the work to. */
export const noFallbackLeft = (role: Role, runners: readonly ModelPreset[]): string =>
  runners.length <= 1 ? `No other preset is set for ${ROLE_LABEL[role]}, so nothing else was tried. Tell the user; they can add a fallback in Settings → Models & roles → Who does what, or you can do this part yourself if they agree.` : `Every preset set for ${ROLE_LABEL[role]} was tried or is not connected. Tell the user.`;

/** What a replacement session is told before its brief: someone started this and could not finish. */
export const takeoverIntro = (from: ModelPreset, sameFolder: boolean): string =>
  `Another session (${named(from)}) started this part and could not finish it. ${sameFolder ? 'What it changed is already in this folder: read what is there before you start, and carry on from it instead of starting over.' : 'Its unfinished changes are in its own worktree, not here: do the part from the start.'}`;

/** Why the first choice is passed over before anything starts, in the words used above. */
export const NOT_CONNECTED = 'is not connected';

// ---- the orchestrator -----------------------------------------------------------------------

/** The presets a lead session may move to, in the user's order; none when none is chosen. */
export const orchestratorsOf = (who: WhoDoesWhat): ModelPreset[] => (who.orchestrators ?? (who.orchestrate ? [who.orchestrate] : [])).flatMap((id) => who.presets.filter((p) => p.id === id));

export type OrchestrateMove = 'none' | 'already' | 'move' | 'other-agent';

/**
 * What becoming a lead means for a session on these settings: nothing chosen, already there, a
 * move to a preset, or only presets on other agents (a session keeps its agent). The preset is the
 * first in the user's order on the session's own agent; with none, their first choice, to name.
 */
export function orchestrateMove(presets: readonly ModelPreset[], session: Pick<Controls, 'agent' | 'model' | 'effort' | 'fast'>): { move: OrchestrateMove; preset: ModelPreset | null } {
  const first = presets[0];
  if (!first) return { move: 'none', preset: null };
  const preset = presets.find((p) => p.agent === session.agent);
  if (!preset) return { move: 'other-agent', preset: first };
  return { move: preset.model === session.model && preset.effort === (session.effort ?? '') && preset.fast === (session.fast ?? false) ? 'already' : 'move', preset };
}

/** The always-visible line over the roles: how the order of a role's presets is used. */
export const ROUTING_LINE = 'Kestrel tries each role’s top choice first. If that one is not available, it uses the next on the list, or asks you first.';

export const orchestrateNotice = (preset: ModelPreset, move: Extract<OrchestrateMove, 'move' | 'other-agent'>, agent: Agent): string =>
  move === 'move'
    ? `This session now leads other sessions, so from its next turn it runs on ${named(preset)}, your Orchestrate preset. The model control under the message box changes it back.`
    : `Your Orchestrate preset is ${named(preset)}, and a session keeps its agent, so this one stays the lead on ${AGENT_LABEL[agent]}. To have ${AGENT_LABEL[preset.agent]} lead, start the task in a session on that preset, or add a ${AGENT_LABEL[agent]} preset to Orchestrate.`;

// ---- the rows of the roles table --------------------------------------------------------------

/** A row of Who does what: Orchestrate, then the roles. Each holds an ordered list of presets, top choice first. */
export const ROLE_ROWS = ['orchestrate', 'design', 'build', 'review'] as const;
export type RoleRow = (typeof ROLE_ROWS)[number];
export const ROW_LABEL: Record<RoleRow, string> = { orchestrate: ORCHESTRATE_LABEL, ...ROLE_LABEL };
export const ROW_HELP: Record<RoleRow, string> = { orchestrate: ORCHESTRATE_HELP, ...ROLE_HELP };
/** How many presets a row may list. */
export const MAX_ROW = MAX_REVIEWERS;
/** What an empty row says: who does that work when nobody is chosen. */
export const ROW_EMPTY: Record<RoleRow, string> = { orchestrate: 'Use the session’s current model', design: 'Use the session’s current model', build: 'Use the session’s current model', review: 'Nobody' };

/** A row's presets in the user's order (ids), top choice first. One reading for every row, however it is stored. */
export function rowList(who: WhoDoesWhat, row: RoleRow): string[] {
  if (row === 'orchestrate') return who.orchestrators ?? (who.orchestrate ? [who.orchestrate] : []);
  if (row === 'review') return who.reviewers ?? (who.roles.review ? [who.roles.review] : []);
  const first = who.roles[row];
  return first ? [first, ...(who.fallbacks?.[row] ?? []).filter((id) => id !== first)] : [];
}

/** The record with a row's list replaced: each preset once, at most `MAX_ROW`. */
export function withRowList(who: WhoDoesWhat, row: RoleRow, ids: readonly string[]): WhoDoesWhat {
  const list = [...new Set(ids)].slice(0, MAX_ROW);
  if (row === 'orchestrate') return { ...who, orchestrators: list, orchestrate: list[0] ?? null };
  if (row === 'review') return { ...who, reviewers: list, roles: { ...who.roles, review: list[0] ?? null } };
  return { ...who, roles: { ...who.roles, [row]: list[0] ?? null }, fallbacks: { ...who.fallbacks, [row]: list.slice(1) } };
}

/** The record with a preset taken out of every row (it was removed). */
export const withoutPreset = (who: WhoDoesWhat, id: string): WhoDoesWhat => ROLE_ROWS.reduce((next, row) => withRowList(next, row, rowList(next, row).filter((x) => x !== id)), who);

