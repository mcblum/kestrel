// The settings another computer may change on a worker node (docs/designs/worker-nodes.md, section 10, "The closed
// list, as decided 2026-11-28"). Pure and browser-safe.
//
// A node has no window, so its page on a desktop is where these are changed: each one key of `NODE_SETTINGS`, sent as
// `node.settings.set` with one key and one value (shared/connect-ops.ts, desk only), checked here, and carried out on
// the node by the setting's own function (node-settings/service.ts). Most of them are settings every computer already
// has: its name (Kestrel Connect's), "Other devices may start sessions on this computer" (remote-starts/prefs.ts), what
// its New session box starts with (the remembered choices, shared/sticky-controls.ts) and whether reviews start on
// their own (Settings → Code reviews). The other three are a node's own, each kept where it was first stored, so a
// value stored before this list existed is the value read: Projects and push (project-clone/prefs.ts) and "Keep this
// node on my desktops' version" (node-update/store.ts).
import { isSelectableAgent, SELECTABLE_AGENTS, type Agent } from '../model.ts';
import { DEVICE_NAME_MAX, deviceNameOf } from './connect.ts';
import { NODE_AGENT_LABEL } from './node-agents.ts';
import type { ModelOption } from '../agents/types.ts';
import { fitToModel } from './model-choice.ts';
import type { PermissionLevel } from './permissions.ts';
import type { ReviewMode } from './review-settings.ts';
import { choicesFor, rememberPick, rememberSent, startControls, startFromOf, withFixed, type Remembered } from './sticky-controls.ts';

/** "Clone every project of the account" (the default) or "Clone a project when a session starts in it" (9.1 alone). */
export type MirrorMode = 'every' | 'on-start';
export const MIRROR_MODES: readonly MirrorMode[] = ['every', 'on-start'];
export const MIRROR_MODE_LABEL: Record<MirrorMode, string> = { every: 'Clone every project of the account', 'on-start': 'Clone a project when a session starts in it' };
export const PUSH_LABEL = 'Push each session’s branch when a turn ends';
/** "Keep this node on my desktops' version" (worker-nodes.md 4.2): the setting's words, wherever it is shown. */
export const FOLLOW_LABEL = 'Keep this node on my desktops’ version';

/** The modes a node's New session box may start in, as another computer sets them: Manual and Auto, never Bypass. */
export type NodeStartMode = 'ask' | 'auto';
export const NODE_START_MODES: readonly NodeStartMode[] = ['ask', 'auto'];
export const NODE_START_MODE_LABEL: Record<NodeStartMode, string> = { ask: 'Manual', auto: 'Auto' };

/** A node's settings as its offers record carries them and its page shows them. */
export interface NodeSettingsValues {
  name: string;
  /** "Other devices may start sessions on this node". */
  remoteStarts: boolean;
  /** What its New session box starts with. */
  agent: Agent;
  /** A model of `agent` ('' is the agent's own default). */
  model: string;
  mode: NodeStartMode;
  /** Settings → Code reviews is "Start reviews on their own" (or "Review and reply on their own"). */
  autoReviews: boolean;
  projects: MirrorMode;
  push: boolean;
  followDesktopVersion: boolean;
}

export type NodeSettingKey = keyof NodeSettingsValues;

/** What the node has, for the checks only the node can make: its agents, and each one's models. */
export interface NodeHas {
  /** The node, as other devices call it. */
  here: string;
  /** The agents Kestrel runs there. */
  agents: readonly Agent[];
  /** The New session box's agent now: the one a model is checked against. */
  agent: Agent;
  /** The model ids an agent offers there; null when it cannot list them now (then only its default may be chosen). */
  models(agent: Agent): readonly string[] | null;
}

interface SettingSpec {
  /** The setting's words, as the page shows it. */
  label: string;
  /** Why this value cannot be this setting, or null. `has`: the node's own checks too (only the node passes it). */
  refusal(value: unknown, has?: NodeHas): string | null;
}

const MODEL_ID_MAX = 300;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const onOrOff = (label: string) => (value: unknown): string | null => (typeof value === 'boolean' ? null : `"${label}" is on or off: give true or false.`);

function nameRefusal(value: unknown): string | null {
  if (typeof value !== 'string') return `A worker node's name is text of at most ${DEVICE_NAME_MAX} characters.`;
  try {
    return deviceNameOf(value) ? null : 'A worker node needs a name.';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function agentRefusal(value: unknown, has?: NodeHas): string | null {
  if (!isSelectableAgent(value)) return `The agent is one of: ${SELECTABLE_AGENTS.join(', ')}.`;
  if (has && !has.agents.includes(value)) return `${NODE_AGENT_LABEL[value]} is not on ${has.here}.`;
  return null;
}

function modelRefusal(value: unknown, has?: NodeHas): string | null {
  if (typeof value !== 'string' || value.length > MODEL_ID_MAX || CONTROL.test(value)) return `The model is a model id of at most ${MODEL_ID_MAX} characters.`;
  if (!has || value === '') return null;
  const models = has.models(has.agent);
  return models?.includes(value) ? null : `${value} is not one of the models ${NODE_AGENT_LABEL[has.agent]} offers on ${has.here}. Pick another.`;
}

const modeRefusal = (value: unknown): string | null => (NODE_START_MODES.includes(value as NodeStartMode) ? null : value === 'bypass' ? 'New sessions on a worker node start in Manual or Auto, never Bypass.' : 'The mode is Manual (ask) or Auto (auto).');
const projectsRefusal = (value: unknown): string | null => (MIRROR_MODES.includes(value as MirrorMode) ? null : `Projects is one of: ${MIRROR_MODES.join(', ')}.`);

/** The closed list: every setting another computer may change on a worker node, with each value's check. Nothing else. */
export const NODE_SETTINGS: { readonly [K in NodeSettingKey]: SettingSpec } = {
  name: { label: 'Name', refusal: nameRefusal },
  remoteStarts: { label: 'Other devices may start sessions on this node', refusal: onOrOff('Other devices may start sessions on this node') },
  agent: { label: 'Agent', refusal: agentRefusal },
  model: { label: 'Model', refusal: modelRefusal },
  mode: { label: 'Mode', refusal: modeRefusal },
  autoReviews: { label: 'Start reviews on its own', refusal: onOrOff('Start reviews on its own') },
  projects: { label: 'Projects', refusal: projectsRefusal },
  push: { label: PUSH_LABEL, refusal: onOrOff(PUSH_LABEL) },
  followDesktopVersion: { label: FOLLOW_LABEL, refusal: onOrOff(FOLLOW_LABEL) },
};

export const NODE_SETTING_KEYS = Object.keys(NODE_SETTINGS) as NodeSettingKey[];
export const isNodeSettingKey = (value: unknown): value is NodeSettingKey => typeof value === 'string' && Object.hasOwn(NODE_SETTINGS, value);

/**
 * Why `key` cannot be set to `value` on a worker node, or null when it can: a key not on the list, or a value out of
 * range. Without `has`, the value's shape only (what a desktop and the request's check can know); the node passes
 * `has` for what only it knows (the agents and models it has).
 */
export function nodeSettingRefusal(key: unknown, value: unknown, has?: NodeHas): string | null {
  if (!isNodeSettingKey(key)) return `"${String(key).slice(0, 60)}" is not a setting another computer may change on a worker node.`;
  return NODE_SETTINGS[key].refusal(value, has);
}

// ---- the settings that are a computer's own: what a node's value means in them ---------------------------------

/** Whether reviews start on their own, from Settings → Code reviews' mode. */
export const autoReviewsOf = (mode: ReviewMode): boolean => mode === 'start' || mode === 'reply';

/**
 * The Code reviews mode the switch makes: on, a node that only listed starts them ("reply", which posts in the user's
 * name, is never chosen from another computer, but is kept where it was chosen there); off, it lists them. Unchanged
 * when the switch says what the mode already does.
 */
export function reviewModeFor(on: boolean, now: ReviewMode): ReviewMode {
  if (on === autoReviewsOf(now)) return now;
  return on ? 'start' : 'list';
}

/** A New session box's mode as the node's page shows it: Auto is Auto, anything else starts as Manual. */
export const nodeStartModeOf = (permission: PermissionLevel): NodeStartMode => (permission === 'auto' ? 'auto' : 'ask');

/** A change to what a node's New session box starts with: its agent, its model, or its mode. */
export type NodeStartChange = { key: 'agent'; value: Agent } | { key: 'model'; value: string } | { key: 'mode'; value: NodeStartMode };

/**
 * The New session box's remembered choices after a change from the node's page, made as the box's own Settings makes
 * them (shared/sticky-controls.ts), so the node's New session box and Settings → General read the same thing. The
 * agent: the one new sessions start on (with "Always this", the fixed start's, taking that agent's last picks). The
 * model, fitted to the efforts and fast mode `models` say it takes: picked on the box's agent, and the fixed start's
 * model too. The mode: picked on the box's agent. Pure.
 */
export function withNodeStart(r: Remembered, change: NodeStartChange, models: readonly ModelOption[] = []): Remembered {
  const now = startControls(r);
  const fixed = startFromOf(r) === 'fixed' ? r.fixed! : null;
  if (change.key === 'agent') {
    if (!fixed) return rememberSent({ agent: change.value, projectId: r.projectId }, r);
    const c = choicesFor(r, change.value);
    return withFixed(r, { agent: change.value, model: c.model, effort: c.effort, fast: c.fast, projectId: fixed.projectId });
  }
  if (change.key === 'mode') return rememberPick(r, { agent: now.agent, permission: change.value });
  const fitted = fitToModel(models, { model: change.value, effort: now.effort ?? '', fast: now.fast ?? false });
  const picked = rememberPick(r, { agent: now.agent, model: change.value, effort: fitted.effort ?? '', fast: fitted.fast === true });
  return fixed ? withFixed(picked, { agent: fixed.agent, model: change.value, effort: fitted.effort ?? '', fast: fitted.fast === true, projectId: fixed.projectId }) : picked;
}

// ---- the record's reader ------------------------------------------------------------------------------------

const obj = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/** The settings as a reader may use them; null when any of them is not one. */
export function asNodeSettings(raw: unknown): NodeSettingsValues | null {
  const o = obj(raw);
  if (!o) return null;
  for (const key of NODE_SETTING_KEYS) if (nodeSettingRefusal(key, o[key]) !== null) return null;
  return {
    name: o.name as string,
    remoteStarts: o.remoteStarts as boolean,
    agent: o.agent as Agent,
    model: o.model as string,
    mode: o.mode as NodeStartMode,
    autoReviews: o.autoReviews as boolean,
    projects: o.projects as MirrorMode,
    push: o.push as boolean,
    followDesktopVersion: o.followDesktopVersion as boolean,
  };
}

// ---- the two actions --------------------------------------------------------------------------------------

/** What `node.restart` answers when it restarts. */
export interface NodeRestartAnswer {
  text: string;
}

/** `node.restart` while a turn runs, naming the sessions. */
export const restartBusy = (here: string, sessions: readonly string[]): string =>
  `${here} has ${sessions.length === 1 ? 'a turn' : 'turns'} running in ${sessions.map((s) => `“${s}”`).join(', ')}. Restart it when ${sessions.length === 1 ? 'that turn ends' : 'they end'}, or stop ${sessions.length === 1 ? 'it' : 'them'} first.`;

/** `node.restart` where systemd does not run the node, so nothing would start it again. */
export const restartNoService = (here: string): string => `${here} does not run under its systemd service, so a restart would leave it stopped. Restart it in its terminal.`;

/** What a restart that was started says. */
export const restartingText = (here: string): string => `${here} is restarting. It is back in a few seconds.`;

/** `node.settings.set` or `node.restart` asked of a computer that is not a worker node. */
export const notANode = (here: string): string => `${here} is not a worker node: its settings are changed in its own window.`;
