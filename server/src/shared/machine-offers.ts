// What a computer offers for a new session, held on Kestrel Connect (docs/designs/kestrel-connect.md, "What a
// computer offers, as built"; Matt, 2026-11-26: "when Kestrel opens on a machine, can we please publish to the
// server (encrypted as always) what the machine offers so that the phone app can just read it?"). Pure.
//
// Each computer holds one sealed record in the list `offers`: exactly the answer `session.startChoices` gives
// (remote-starts/offers.ts builds both from one function), with the computer and when it was made. A phone or
// another desktop reads it from the change feed instead of asking the computer, and asks live only when the
// record is missing, of a version it does not know, or does not open. Its age is never a reason: a computer
// that stays connected rewrites it only when what it says changes.
//
// Every string passes `cleanOffers` before it is sealed or answered: the home folder becomes `~` (whatever its
// separators or letter case), this computer's user name becomes "(user)" where it stands as a word, an email
// address becomes "(an account)", and a string with the shape of a key becomes "(hidden)" whole.
import type { Agent } from '../model.ts';
import type { Machine } from './machines.ts';
import type { PermissionLevel } from './permissions.ts';
import type { ModelPreset } from './who-does-what.ts';
import { keyShapeIn } from './setup-record.ts';

/** The list every computer's record is in, before tagging. */
export const OFFERS_LIST = 'offers';
/** What a computer's record is filed under, before tagging. */
export const offersLabel = (machineId: string): string => `offers|${machineId}`;
/** The record's version. A reader that does not know it asks live. */
export const OFFERS_VERSION = 1;
/** A record whose sealed body (the base64url text the service holds) is longer than this is refused, unread. */
export const MAX_OFFERS_BODY = 256 * 1024;
/** What stands in for a string that looked like a secret. */
export const HIDDEN = '(hidden)';

const MAX_ID = 200;
const MAX_TEXT = 2000;
const MAX_ITEMS = 500;
const AGENTS: readonly Agent[] = ['claude', 'codex', 'opencode'];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** What a device is offered to start a session on this computer with (`session.startChoices`, and the computer's `offers` record on Kestrel Connect: one value, remote-starts/offers.ts). */
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
  /** The projects a session may be started in here, by name; never one kept off Kestrel Connect. */
  projects: RemoteStartProject[];
}

/** A project of this computer as a device picks it: send back `id`, and a folder's `id` as `folderId`. */
export interface RemoteStartProject {
  id: string;
  name: string;
  /** Its folders, by name (never a path); a session starts in `defaultFolderId` unless one is picked. Empty: a project with no folder. */
  folders: { id: string; name: string }[];
  defaultFolderId: string | null;
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

/** A computer's record as it is sealed. */
export interface OffersRecord {
  v: typeof OFFERS_VERSION;
  kind: 'offers';
  machine: Machine;
  /** When the offers were read (ms since 1970, the writer's clock). */
  made: number;
  offers: RemoteStartChoices;
}

/** Another computer's offers as this computer keeps them. */
export interface HeldOffers {
  machine: Machine;
  made: number;
  offers: RemoteStartChoices;
}

/** Machine id -> what it offers: the window's slice. */
export type MachineOffersView = Readonly<Record<string, HeldOffers>>;

export const offersRecordOf = (machine: Machine, made: number, offers: RemoteStartChoices): OffersRecord => ({ v: OFFERS_VERSION, kind: 'offers', machine: { id: machine.id, name: machine.name }, made, offers });

/** Who this computer is, as nothing that leaves it may say: its home folder and its user name. */
export interface Private {
  home: string;
  user: string;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The home folder as a pattern: any separators between its parts, any letter case. */
function homePattern(home: string): RegExp | null {
  const parts = home.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return null;
  const drive = /^[A-Za-z]:$/.test(parts[0]!) ? '' : '[\\\\/]+';
  return new RegExp(drive + parts.map(escape).join('[\\\\/]+') + '(?![A-Za-z0-9_.-])', 'gi');
}

/** One string as it may leave this computer: the home folder as `~`, the user name and an email address replaced, nothing shaped like a key. */
export function cleanText(text: string, who: Private): string {
  if (keyShapeIn(text)) return HIDDEN;
  const home = homePattern(who.home);
  let out = home ? text.replace(home, '~') : text;
  out = out.replace(EMAIL, '(an account)');
  if (who.user.length >= 2) out = out.replace(new RegExp(`(?<![A-Za-z0-9_])${escape(who.user)}(?![A-Za-z0-9_])`, 'gi'), '(user)');
  return out;
}

/** Every string of a value through `cleanText`; the shape is kept. */
export function cleanOffers<T>(value: T, who: Private): T {
  if (typeof value === 'string') return cleanText(value, who) as T;
  if (Array.isArray(value)) return value.map((v) => cleanOffers(v, who)) as T;
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanOffers(v, who)])) as T;
  return value;
}

const obj = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const id = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 && value.length < MAX_ID ? value : null);
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_TEXT;
const agent = (value: unknown): value is Agent => AGENTS.includes(value as Agent);
/** The elements of a list that read as one, the rest dropped. */
const each = <T>(value: unknown, read: (raw: Record<string, unknown>) => T | null): T[] => (Array.isArray(value) ? value.slice(0, MAX_ITEMS).flatMap((raw) => ((o) => (o ? (read(o) ?? []) : []))(obj(raw))) : []);

const asPreset = (p: Record<string, unknown>): ModelPreset | null => (id(p.id) && text(p.name) && agent(p.agent) && text(p.model) && text(p.effort) && typeof p.fast === 'boolean' ? { id: p.id as string, name: p.name, agent: p.agent, model: p.model, effort: p.effort, fast: p.fast } : null);
const asModel = (m: Record<string, unknown>): RemoteStartModel | null => (text(m.id) && text(m.name) ? { id: m.id, name: m.name, ...(m.more === true ? { more: true as const } : {}) } : null);
function asProvider(p: Record<string, unknown>): RemoteStartProvider | null {
  const models = each(p.models, asModel);
  if (!agent(p.agent) || !text(p.name) || !text(p.default) || !models.some((m) => m.id === p.default)) return null;
  return { agent: p.agent, name: p.name, models, default: p.default };
}
const asMissing = (m: Record<string, unknown>): RemoteStartMissing | null => (agent(m.agent) && text(m.name) && text(m.reason) ? { agent: m.agent, name: m.name, reason: m.reason } : null);
const asFolder = (f: Record<string, unknown>): { id: string; name: string } | null => (id(f.id) && text(f.name) ? { id: f.id as string, name: f.name } : null);
function asProject(p: Record<string, unknown>): RemoteStartProject | null {
  if (!id(p.id) || !text(p.name)) return null;
  const folders = each(p.folders, asFolder);
  const defaultFolderId = typeof p.defaultFolderId === 'string' && folders.some((f) => f.id === p.defaultFolderId) ? p.defaultFolderId : null;
  return { id: p.id as string, name: p.name, folders, defaultFolderId };
}
function asStart(raw: unknown): RemoteStartChoices['start'] | null {
  const s = obj(raw);
  if (!s || !agent(s.agent) || !text(s.model) || !text(s.effort) || typeof s.fast !== 'boolean' || typeof s.permission !== 'string' || s.permission === 'bypass') return null;
  return { agent: s.agent, model: s.model, effort: s.effort, fast: s.fast, permission: s.permission as PermissionLevel };
}

/** The offers as a reader may use them: every element of every list checked, the malformed ones dropped; null when the whole is not offers. */
function asOffers(raw: unknown): RemoteStartChoices | null {
  const o = obj(raw);
  const start = o && asStart(o.start);
  if (!o || !start || !text(o.here) || typeof o.allowed !== 'boolean') return null;
  for (const list of ['agents', 'presets', 'providers', 'missing', 'projects'] as const) if (!Array.isArray(o[list])) return null;
  return {
    here: o.here,
    allowed: o.allowed,
    ...(!o.allowed && text(o.refusal) ? { refusal: o.refusal } : {}),
    agents: (o.agents as unknown[]).filter(agent),
    presets: each(o.presets, asPreset),
    start,
    providers: each(o.providers, asProvider),
    missing: each(o.missing, asMissing),
    projects: each(o.projects, asProject),
  };
}

/** A record as opened, or null when it is not one. Which machine may write it, and under which id, are the caller's to check. */
export function asOffersRecord(raw: unknown): HeldOffers | null {
  const r = obj(raw);
  const machine = r && obj(r.machine);
  const machineId = machine && id(machine.id);
  if (!r || r.kind !== 'offers' || r.v !== OFFERS_VERSION || !machineId || typeof r.made !== 'number' || !Number.isFinite(r.made)) return null;
  const offers = asOffers(r.offers);
  return offers && { machine: { id: machineId, name: text(machine.name) ? machine.name : '' }, made: r.made, offers };
}

/** The window's slice as pushed: only entries that are held offers, keyed by their machine. */
export function asMachineOffersView(raw: unknown): MachineOffersView {
  const o = obj(raw);
  if (!o) return {};
  return Object.fromEntries(
    Object.entries(o).flatMap(([key, value]) => {
      const held = asOffersRecord({ ...obj(value), v: OFFERS_VERSION, kind: 'offers' });
      return held && held.machine.id === key ? [[key, held]] : [];
    }),
  );
}
