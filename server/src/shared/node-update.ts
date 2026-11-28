// A worker node follows the account's desktops (docs/designs/worker-nodes.md, section 4.2; Matt, 2026-11-28: "we want
// the nodes to be the same version as the clients interacting with it"). Its target is the newest version a desktop of
// the account runs: never one no desktop is on, never down, and other nodes and phones do not count. One pure step
// decides (`nodeUpdateStep`); the updater (node-update/updater.ts) only carries it out. Versions are compared by one
// function here (`compareVersions`: `0.0.35-beta.2` < `0.0.35`). What the node's offers record says of it
// (`NodeUpdateNote`) is worded once, by `nodeUpdateLine`, for the New session box's computer pill, Settings →
// Connections and `kestrel node status` alike. Pure: no Node, so the page shares it.
import type { KestrelKind } from './host-kind.ts';

/** A release (`1.2.3`) or a beta of one (`1.2.3-beta.4`), as the install script takes them. */
const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-beta\.(\d{1,6}))?$/;

export const isVersion = (value: unknown): value is string => typeof value === 'string' && VERSION.test(value);

/** The parts of a version, or null when it is not one. A release has no beta number. */
function partsOf(version: string): { numbers: [number, number, number]; beta: number | null } | null {
  const m = VERSION.exec(version);
  return m ? { numbers: [Number(m[1]), Number(m[2]), Number(m[3])], beta: m[4] === undefined ? null : Number(m[4]) } : null;
}

/**
 * Negative when `a` is older than `b`, positive when newer, 0 when the same. A beta is older than the release it leads
 * to (`0.0.35-beta.2` < `0.0.35`) and newer than the release before. Something that is not a version is older than any
 * version, and the same as anything else that is not one.
 */
export function compareVersions(a: string, b: string): number {
  const pa = partsOf(a);
  const pb = partsOf(b);
  if (!pa || !pb) return (pa ? 1 : 0) - (pb ? 1 : 0);
  for (let i = 0; i < 3; i++) if (pa.numbers[i] !== pb.numbers[i]) return pa.numbers[i]! - pb.numbers[i]!;
  if (pa.beta === pb.beta) return 0;
  if (pa.beta === null) return 1;
  if (pb.beta === null) return -1;
  return pa.beta - pb.beta;
}

/** The newest of these; null when none is a version (an unknown version does not count). */
export function newestVersion(versions: readonly (string | null | undefined)[]): string | null {
  return versions.filter(isVersion).reduce<string | null>((best, v) => (best === null || compareVersions(v, best) > 0 ? v : best), null);
}

/** What holds an update back: the sessions whose turns run (by title), and the clones and pushes under way. */
export interface NodeBusy {
  /** Sessions working now, or waiting on a card a restart would lose (shared/restart-cards.ts). */
  sessions: readonly string[];
  clones: number;
  pushes: number;
}

export const NOT_BUSY: NodeBusy = { sessions: [], clones: 0, pushes: 0 };

/** A version this node could not move to, remembered through the Persistence facade (node-update/store.ts). */
export interface FailedUpdate {
  version: string;
  /** The reason in the node's words: the install script's last lines, or that the version has no build for a node. */
  reason: string;
  /** The version has no node bundle: it is not a target (said as such, not as a failure). */
  noBuild?: true;
}

export interface NodeUpdateFacts {
  kind: KestrelKind;
  /** This node's version. */
  version: string;
  /** The version each desktop of the account runs, as its offers record says; null where it says none (an older app). */
  desktops: readonly (string | null)[];
  /** "Keep this node on my desktops' version". Off, a node moves only by `kestrel upgrade`. */
  on: boolean;
  /** Update now was asked (`node.update`): it waits only for running turns, and tries a version that failed again. */
  asked: boolean;
  busy: NodeBusy;
  /** The version that last failed, or null. */
  failed: FailedUpdate | null;
  /** It runs under its systemd user unit: the only way an update restarts it. */
  service: boolean;
  /** An update to this version was started and has not ended. */
  updating: string | null;
}

/** Why a node stays where it is. */
export type NodeStayWhy = 'not-a-node' | 'no-desktop' | 'current' | 'updating' | 'failed' | 'no-build' | 'off' | 'no-service';

export type NodeUpdateStep =
  | { do: 'stay'; why: NodeStayWhy; to?: string; reason?: string }
  | { do: 'wait'; to: string; busy: NodeBusy }
  | { do: 'update'; to: string };

const isBusy = (b: NodeBusy): boolean => b.sessions.length > 0 || b.clones > 0 || b.pushes > 0;

/**
 * What the node does now: stay (and why), wait for its work (naming it), or update to a version. Never on a desktop,
 * never to a version no desktop runs, never down. A version that failed is not tried again until Update now; one with
 * no build for a node is not a target until then either. Update now waits only for running turns.
 */
export function nodeUpdateStep(f: NodeUpdateFacts): NodeUpdateStep {
  if (f.kind !== 'node') return { do: 'stay', why: 'not-a-node' };
  if (f.updating) return { do: 'stay', why: 'updating', to: f.updating };
  const to = newestVersion(f.desktops);
  if (to === null) return { do: 'stay', why: 'no-desktop' };
  // A copy that does not know its own version (a checkout's) is never moved.
  if (!isVersion(f.version) || compareVersions(to, f.version) <= 0) return { do: 'stay', why: 'current' };
  if (f.failed && f.failed.version === to && !f.asked) return { do: 'stay', why: f.failed.noBuild ? 'no-build' : 'failed', to, reason: f.failed.reason };
  if (!f.on && !f.asked) return { do: 'stay', why: 'off', to };
  if (!f.service) return { do: 'stay', why: 'no-service', to };
  const busy = f.asked ? { sessions: f.busy.sessions, clones: 0, pushes: 0 } : f.busy;
  if (isBusy(busy)) return { do: 'wait', to, busy };
  return { do: 'update', to };
}

/** What the node's offers record says of an update (`update: { to, state }`), for every other screen. */
export type NodeUpdateState = 'waiting' | 'updating' | 'failed' | 'no-build' | 'held';

export interface NodeUpdateNote {
  to: string;
  state: NodeUpdateState;
  /** Failed: the reason; held: why it moves only by `kestrel upgrade`. */
  reason?: string;
  /** Waiting: what it waits for. */
  busy?: NodeBusy;
}

/** Why a node that is behind its desktops moves only by hand, in words for every screen. */
export const HELD_OFF = 'Keep this node on my desktops’ version is off, so it moves only by `kestrel upgrade`.';
export const HELD_NO_SERVICE = 'It runs without its service, so it moves only by `kestrel upgrade`.';

/** The note the node publishes for a step, or null when there is nothing to say (it is on its desktops' version). */
export function noteOfStep(step: NodeUpdateStep): NodeUpdateNote | null {
  if (step.do === 'update') return { to: step.to, state: 'updating' };
  if (step.do === 'wait') return { to: step.to, state: 'waiting', busy: step.busy };
  if (!step.to) return null;
  switch (step.why) {
    case 'updating':
      return { to: step.to, state: 'updating' };
    case 'failed':
      return { to: step.to, state: 'failed', reason: step.reason ?? '' };
    case 'no-build':
      return { to: step.to, state: 'no-build' };
    case 'off':
      return { to: step.to, state: 'held', reason: HELD_OFF };
    case 'no-service':
      return { to: step.to, state: 'held', reason: HELD_NO_SERVICE };
    default:
      return null;
  }
}

/**
 * The install script's exit code when the version asked for has no node bundle (its checksum file is not there):
 * not a failure of the node but a version that is not a target (scripts/release/install.sh).
 */
export const INSTALL_NO_BUNDLE_EXIT = 4;

/** "0.0.35 has no build for worker nodes." */
export const noBuildText = (version: string): string => `${version} has no build for worker nodes.`;

/** What a start is refused with while a node updates. */
export const updatingRefusal = (name: string, to: string): string => `${name} is updating to ${to}. Try again in a minute.`;

/** "its sessions", "its clones and pushes": what a waiting node waits for, in a few words. */
function waitedFor(busy: NodeBusy | undefined): string {
  const parts = [busy && busy.sessions.length > 0 ? 'sessions' : null, busy && busy.clones > 0 ? 'clones' : null, busy && busy.pushes > 0 ? 'pushes' : null].filter((p): p is string => p !== null);
  if (parts.length === 0) return 'its sessions';
  return `its ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`}`;
}

/**
 * The one line every screen shows of a node's update, or null when there is none: "Worker node 1 is on 0.0.34; it
 * updates to 0.0.35 when its sessions finish." `version` is the node's own (null where its record says none).
 */
export function nodeUpdateLine(name: string, version: string | null, note: NodeUpdateNote | null | undefined): string | null {
  if (!note) return null;
  const on = version ? `${name} is on ${version}` : name;
  switch (note.state) {
    case 'waiting':
      return `${on}; it updates to ${note.to} when ${waitedFor(note.busy)} finish.`;
    case 'updating':
      return `${name} is updating to ${note.to}.`;
    case 'failed':
      return `${on}; its update to ${note.to} failed${note.reason ? `: ${note.reason.replace(/\.?\s*$/, '.')}` : '.'} It is tried again only by Update now.`;
    case 'no-build':
      return `${on}. ${noBuildText(note.to)}`;
    case 'held':
      return `${on}; your desktops are on ${note.to}. ${note.reason ?? HELD_OFF}`;
  }
}

/** Whether Update now has something to do: a node behind its desktops that is not updating already. */
export const canUpdateNow = (note: NodeUpdateNote | null | undefined): boolean => note !== null && note !== undefined && note.state !== 'updating';

/** What `node.update` answers: the version it moves to, whether it started, and the turns it waits for. */
export interface UpdateNowAnswer {
  to: string | null;
  started: boolean;
  waitingFor: string[];
  /** The line, as `nodeUpdateLine` says it, or why there is nothing to do. */
  text: string;
}

/** The note as a reader may use it (an offers record is outside data), or null. */
export function asNodeUpdateNote(raw: unknown): NodeUpdateNote | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const states: readonly NodeUpdateState[] = ['waiting', 'updating', 'failed', 'no-build', 'held'];
  if (!isVersion(r.to) || !states.includes(r.state as NodeUpdateState)) return null;
  const reason = typeof r.reason === 'string' ? r.reason.slice(0, 500) : undefined;
  const b = typeof r.busy === 'object' && r.busy !== null ? (r.busy as Record<string, unknown>) : null;
  const count = (v: unknown) => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : 0);
  const busy = b ? { sessions: Array.isArray(b.sessions) ? b.sessions.filter((s): s is string => typeof s === 'string').slice(0, 20).map((s) => s.slice(0, 200)) : [], clones: count(b.clones), pushes: count(b.pushes) } : undefined;
  return { to: r.to, state: r.state as NodeUpdateState, ...(reason !== undefined ? { reason } : {}), ...(busy ? { busy } : {}) };
}
