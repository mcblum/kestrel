// A session started on this computer by another device of the account, from a blank page (A8 in
// account-sessions.md, section 11; stage 6, its phone part): what it may pick from, and what its pick
// becomes. The machine checks it as its own New session box's start is checked; the only differences are
// the machine's switch (prefs.ts) and that the mode is never Bypass. Pure.
import type { Agent } from '../model.ts';
import { SELECTABLE_AGENTS } from '../model.ts';
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

export function remoteStartChoices(here: string, allowed: boolean, refusal: string, presets: ModelPreset[], uiState: string | null): RemoteStartChoices {
  return { here, allowed, ...(allowed ? {} : { refusal }), agents: [...SELECTABLE_AGENTS], presets, start: deskStart(uiState) };
}

/** No such preset here, in words naming this computer. */
export const noSuchPreset = (here: string): string => `That preset is not on ${here} any more. Pick another.`;

/**
 * What a pick becomes. A preset: its agent, model, effort and fast mode. An agent: what is remembered here
 * for it. Neither: the New session box's choices. The mode is the one picked, else the box's, never Bypass.
 */
export function remoteStartRun(pick: RemoteStartPick, presets: readonly ModelPreset[], uiState: string | null, here: string): RemoteStartRun {
  const r = remembered(uiState);
  const permissionOf = (fallback: PermissionLevel): PermissionLevel => pick.mode ?? remoteStartPermission(fallback);
  if (pick.presetId !== undefined) {
    const preset = presets.find((p) => p.id === pick.presetId);
    if (!preset) throw new Refused(noSuchPreset(here));
    return { agent: preset.agent, ...filled(preset.model, preset.effort, preset.fast), permission: permissionOf(choicesFor(r, preset.agent).permission), modelChosen: true };
  }
  if (pick.agent !== undefined) {
    const c = choicesFor(r, pick.agent);
    return { agent: pick.agent, ...filled(c.model, c.effort, c.fast), permission: permissionOf(c.permission), modelChosen: true };
  }
  const c = startControls(r);
  return { agent: c.agent, ...filled(c.model ?? '', c.effort ?? '', c.fast === true), permission: permissionOf(c.permission) };
}
