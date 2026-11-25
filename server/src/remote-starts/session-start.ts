// A session started on this computer by another device of the account, from a blank page (A8 in
// account-sessions.md, section 11; stage 6, its phone part): what it may pick from, and what its pick
// becomes. The machine checks it as its own New session box's start is checked; the only differences are
// the machine's switch (prefs.ts) and that the mode is never Bypass. Pure.
import type { ModelOption } from '../agents/types.ts';
import type { Agent } from '../model.ts';
import { AGENT_LABEL, SELECTABLE_AGENTS } from '../model.ts';
import { fitToModel, menuRows, rowIdFor } from '../shared/model-choice.ts';
import { Refused } from '../refused.ts';
import { remoteStartPermission, type PermissionLevel } from '../shared/permissions.ts';
import { choicesFor, startControls, storedRemembered } from '../shared/sticky-controls.ts';
import type { ModelPreset } from '../shared/who-does-what.ts';

/** The modes another device may start a session in: Manual and Auto. Bypass is chosen at the machine. */
export const REMOTE_START_MODES = ['ask', 'auto'] as const satisfies readonly PermissionLevel[];
export type RemoteStartMode = (typeof REMOTE_START_MODES)[number];

/** What a start asked from another device picks. Neither `presetId` nor `agent`: what this computer's New session box would start with. */
export interface RemoteStartPick {
  presetId?: string;
  agent?: Agent;
  /** A model of `agent`, one of its `models` in `providers` (Matt, 2026-11-25). Only with `agent`. */
  model?: string;
  /** Absent: the mode this computer's New session box would start in, never Bypass. */
  mode?: RemoteStartMode;
}

/** What `session.start` hands the runtime, beside the project, the message and its photos. */
export interface RemoteStartRun {
  agent: Agent;
  model?: string;
  effort?: string;
  fast?: boolean;
  permission: PermissionLevel;
  /** A preset or an agent was picked on the phone: the session keeps that when it leads, as a pick at the desk does. */
  modelChosen?: true;
}

/** What a device is offered to start a session on this computer with (`session.startChoices`). Projects come from `state.read`. */
export interface RemoteStartChoices {
  /** This computer, as refusals name it. */
  here: string;
  /** Settings → Workflow → "Other devices may start sessions on this computer". Off: `refusal` says so, and `session.start` is refused with it. */
  allowed: boolean;
  refusal?: string;
  agents: Agent[];
  presets: ModelPreset[];
  /** What the New session box here starts with: preselected on the phone. */
  start: { agent: Agent; model: string; effort: string; fast: boolean; permission: PermissionLevel };
  /** The agents that can start a session here now, each with the desk's own model menu (Matt, 2026-11-25). */
  providers: RemoteStartProvider[];
  /** The agents left out of `providers`, and why, in words a phone shows. */
  missing: RemoteStartMissing[];
}

/** One row of the desk's model menu, as a phone shows it: send back `id` ('' is the agent's own default), show `name`. */
export interface RemoteStartModel {
  id: string;
  name: string;
  /** Listed under "More models" at the desk. */
  more?: true;
}

export interface RemoteStartProvider {
  agent: Agent;
  name: string;
  models: RemoteStartModel[];
  /** The row the desk's box starts this agent on; always one of `models`. */
  default: string;
}

export interface RemoteStartMissing {
  agent: Agent;
  name: string;
  reason: string;
}

/** What the desk knows of one agent: whether it can start now (and why not), and the one model list it keeps for it. */
export interface AgentModels {
  agent: Agent;
  available: boolean;
  reason?: string;
  models: readonly ModelOption[];
}

const DEFAULT_ROW: RemoteStartModel = { id: '', name: 'Default' };

/** An agent that cannot start here, in words naming this computer when it gave none. */
const cannotStart = (a: AgentModels, here: string): string => a.reason ?? `${AGENT_LABEL[a.agent]} cannot start a session on ${here} now.`;

function providerOf(a: AgentModels, r: ReturnType<typeof storedRemembered>): RemoteStartProvider {
  const rows = menuRows(a.models).map(({ option, more }): RemoteStartModel => ({ id: option.id, name: option.label, ...(more ? { more: true as const } : {}) }));
  const models = rows.length > 0 ? rows : [DEFAULT_ROW];
  const remembered = rowIdFor(a.models, choicesFor(r, a.agent).model) ?? rowIdFor(a.models, '');
  return { agent: a.agent, name: AGENT_LABEL[a.agent], models, default: models.some((m) => m.id === remembered) ? remembered! : models[0]!.id };
}

function remembered(uiState: string | null) {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = uiState ? JSON.parse(uiState) : {};
    if (typeof parsed === 'object' && parsed !== null) stored = parsed as Record<string, unknown>;
  } catch {
    // Unreadable: what a new session starts with by default.
  }
  return storedRemembered(stored);
}

const filled = (model: string, effort: string, fast: boolean) => ({ ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(fast ? { fast: true } : {}) });

/** The New session box's choices here, as a phone is shown them; the mode never Bypass. */
export function deskStart(uiState: string | null): RemoteStartChoices['start'] {
  const c = startControls(remembered(uiState));
  return { agent: c.agent, model: c.model ?? '', effort: c.effort ?? '', fast: c.fast === true, permission: remoteStartPermission(c.permission) };
}

export function remoteStartChoices(here: string, allowed: boolean, refusal: string, presets: ModelPreset[], uiState: string | null, agents: readonly AgentModels[]): RemoteStartChoices {
  const r = remembered(uiState);
  return {
    here,
    allowed,
    ...(allowed ? {} : { refusal }),
    agents: [...SELECTABLE_AGENTS],
    presets,
    start: deskStart(uiState),
    providers: agents.filter((a) => a.available).map((a) => providerOf(a, r)),
    missing: agents.filter((a) => !a.available).map((a) => ({ agent: a.agent, name: AGENT_LABEL[a.agent], reason: cannotStart(a, here) })),
  };
}

/** A model that is not one of the agent's here, in words naming this computer. */
export const notAModel = (model: string, agent: Agent, here: string): string => `${model || 'That model'} is not one of the models ${AGENT_LABEL[agent]} offers on ${here}. Pick another.`;
export const MODEL_WITHOUT_AGENT = 'Say which agent the model is for.';

/** No such preset here, in words naming this computer. */
export const noSuchPreset = (here: string): string => `That preset is not on ${here} any more. Pick another.`;

/**
 * What a pick becomes. A preset: its agent, model, effort and fast mode. An agent: what is remembered here
 * for it, or with `model` that model and what is remembered for the agent fitted to it, checked against the
 * agent's list (`agents`). Neither: the New session box's choices. The mode is the one picked, else the box's, never Bypass.
 */
export function remoteStartRun(pick: RemoteStartPick, presets: readonly ModelPreset[], uiState: string | null, here: string, agents: readonly AgentModels[] = []): RemoteStartRun {
  const r = remembered(uiState);
  const permissionOf = (fallback: PermissionLevel): PermissionLevel => pick.mode ?? remoteStartPermission(fallback);
  if (pick.presetId !== undefined) {
    const preset = presets.find((p) => p.id === pick.presetId);
    if (!preset) throw new Refused(noSuchPreset(here));
    return { agent: preset.agent, ...filled(preset.model, preset.effort, preset.fast), permission: permissionOf(choicesFor(r, preset.agent).permission), modelChosen: true };
  }
  if (pick.model !== undefined) {
    if (pick.agent === undefined) throw new Refused(MODEL_WITHOUT_AGENT);
    const known = agents.find((a) => a.agent === pick.agent);
    if (!known || !known.available) throw new Refused(known ? cannotStart(known, here) : notAModel(pick.model, pick.agent, here));
    if (!providerOf(known, r).models.some((m) => m.id === pick.model)) throw new Refused(notAModel(pick.model, pick.agent, here));
    const c = choicesFor(r, pick.agent);
    const fitted = fitToModel(known.models, { model: pick.model, effort: c.effort, fast: c.fast });
    return { agent: pick.agent, ...filled(pick.model, fitted.effort ?? '', fitted.fast === true), permission: permissionOf(c.permission), modelChosen: true };
  }
  if (pick.agent !== undefined) {
    const c = choicesFor(r, pick.agent);
    return { agent: pick.agent, ...filled(c.model, c.effort, c.fast), permission: permissionOf(c.permission), modelChosen: true };
  }
  const c = startControls(r);
  return { agent: c.agent, ...filled(c.model ?? '', c.effort ?? '', c.fast === true), permission: permissionOf(c.permission) };
}
