// Copying a set-up step's missing values from another computer (docs/designs/onboarding.md, section 19;
// approved by Matt, 2026-11-25). What may be copied, from where, in which words, and what the computer
// that answered keeps of it (names only). Only an MCP server's environment and header values and a Claude
// settings file's `env` values that a line names as missing; never anything else. Pure and browser-safe:
// nothing here reads a value, and no type here has a field a value could go in except the answer itself.
import type { SetupRecord } from './setup-record.ts';

/** The desk-only operation that asks another computer for a step's values. */
export const SETUP_VALUES_OP = 'setup.values';
/** The desk-only operations this copy of Kestrel answers, carried in its set-up record (19.8). */
export const SETUP_ANSWERS: readonly string[] = [SETUP_VALUES_OP];
/** How long the answering computer's person has to say Allow or Deny (Matt, 2026-11-25). */
export const VALUE_REQUEST_TTL_MS = 120_000;
/** As many names as one request asks for. */
export const VALUE_NAMES_MAX = 32;
/** The longest value one name may carry, in UTF-16 code units. */
export const VALUE_MAX = 16 * 1024;
/** As many entries as the record of what was sent keeps (Matt, 2026-11-25). */
export const SENT_MAX = 50;
/** An environment variable's or an HTTP header's name. */
export const VALUE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
/** The setting the answering computer keeps its record of what was sent in (19.14). */
export const SETUP_SENT_KEY = 'setup-values-sent';

/** The step a line id names, when its values may be copied at all. */
export type CopyStep = { kind: 'mcp'; server: string } | { kind: 'settings'; path: string };

/** What a line id names, for copying: an MCP server or a settings file; null for anything else. Pure. */
export function copyStepOf(lineId: string): CopyStep | null {
  if (lineId.startsWith('mcp:') && lineId.length > 4) return { kind: 'mcp', server: lineId.slice(4) };
  if (lineId.startsWith('file:') && lineId.length > 5) return { kind: 'settings', path: lineId.slice(5) };
  return null;
}

const unique = (names: readonly string[]): string[] => [...new Set(names)];

/**
 * The names a machine's record has for a step whose values may be copied, or null when it has no such step.
 * An MCP server: its environment variables' and headers' names (a server with an argument or address part
 * left out cannot be added from the list, so has none). A settings file: Claude's, its `env` block's names.
 * Pure.
 */
export function copyableNames(record: Pick<SetupRecord, 'mcp' | 'files'>, lineId: string): string[] | null {
  const step = copyStepOf(lineId);
  if (!step) return null;
  if (step.kind === 'mcp') {
    const servers = record.mcp.filter((s) => s.name === step.server);
    if (servers.length === 0 || servers.every((s) => s.blanks.some((b) => b.kind !== 'env' && b.kind !== 'header'))) return null;
    const held = servers.filter((s) => s.blanks.every((b) => b.kind === 'env' || b.kind === 'header'));
    return unique(held.flatMap((s) => s.blanks.map((b) => b.name)));
  }
  const file = record.files.find((f) => f.path === step.path && f.kind === 'settings' && f.agent === 'claude' && !f.keyAt);
  return file ? unique(file.env) : null;
}

/** Whether a machine's Kestrel answers `setup.values` (its record says so; an older one's does not). Pure. */
export const answersCopy = (record: Pick<SetupRecord, 'machine'>): boolean => (record.machine.answers ?? []).includes(SETUP_VALUES_OP);

/** One computer a line's values may be copied from: which of the missing names it has, and whether it is too old to ask. */
export interface CopyOffer {
  id: string;
  name: string;
  names: string[];
  older: boolean;
}

/** A line's copy: who has its missing values, and which names are missing here. */
export interface SetupCopy {
  missing: string[];
  offers: CopyOffer[];
}

/**
 * Who a line's missing values may be copied from (`copyValuesOf` of the design). `missing` is what this
 * computer lacks, or 'all' when nothing is here yet (every name a computer has is missing). Null when no
 * other computer has the step or none has any name missing here. The most recently read first. Pure.
 */
export function copyOffersOf(lineId: string, others: readonly SetupRecord[], missing: readonly string[] | 'all'): SetupCopy | null {
  if (!copyStepOf(lineId)) return null;
  const offers = [...others]
    .sort((a, b) => b.readAt - a.readAt)
    .flatMap((r): CopyOffer[] => {
      const has = copyableNames(r, lineId);
      if (!has) return [];
      const names = missing === 'all' ? has : has.filter((n) => missing.includes(n));
      return names.length > 0 ? [{ id: r.machine.id, name: r.machine.name, names, older: !answersCopy(r) }] : [];
    });
  if (offers.length === 0) return null;
  const all = missing === 'all' ? unique(offers.flatMap((o) => o.names)) : [...missing];
  return { missing: all, offers };
}

/** The offer a click uses: the first that can be asked. Pure. */
export const usableOffer = (copy: SetupCopy | null | undefined): CopyOffer | null => copy?.offers.find((o) => !o.older) ?? null;

/** The button. Pure. */
export const copyValuesLabel = (offer: Pick<CopyOffer, 'name'>): string => `Copy values from ${offer.name}`;

/** One entry of the button's menu when several computers have the step: "MacBook Pro: all 2", "Studio iMac: HOMEASSISTANT_URL only". Pure. */
export function copyOfferText(offer: Pick<CopyOffer, 'name' | 'names'>, missing: readonly string[]): string {
  if (offer.names.length === missing.length) return `${offer.name}: ${missing.length === 1 ? offer.names[0] : `all ${missing.length}`}`;
  return `${offer.name}: ${offer.names.join(', ')} only`;
}

/** Why the button cannot be used: the other computer's Kestrel is older. Pure. */
export const olderText = (name: string): string => `Update Kestrel on ${name} to copy values from it.`;

/** The missing row's note: both ways when there is a computer to copy from, else typing here. Pure. */
export function missingNote(copy: SetupCopy | null | undefined, count: number): string {
  const them = count === 1 ? 'it' : 'them';
  const offer = usableOffer(copy);
  return offer ? `Copy ${them} from ${offer.name}, or enter ${them} here.` : `Enter ${them} here.`;
}

const listed = (names: readonly string[]): string => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** The asking computer's toast: what was copied, and what the other computer did not have. Names only. Pure. */
export function copiedText(copied: readonly string[], notThere: readonly string[], from: string, step: string): string {
  const parts = [copied.length > 0 ? `Copied ${listed(copied)} from ${from} into ${step}.` : `${from} had none of them.`, notThere.length > 0 && `Not on ${from}: ${listed(notThere)}; type ${notThere.length === 1 ? 'it' : 'them'} here.`];
  return parts.filter(Boolean).join(' ');
}

/** The answering computer's toast. Names only. Pure. */
export const sentText = (names: readonly string[], to: string, step: string): string => `Sent ${listed(names)} to ${to}, for ${step}.`;

/** The refusals, in the words both ends show. */
export const VALUE_WORDS = {
  denied: (name: string) => `${name} said no.`,
  expired: (name: string) => `${name} did not answer within 2 minutes.`,
  unreachable: (name: string) => `${name} cannot be reached now. Type the values here, or try again when it is on.`,
  busy: (name: string) => `${name} is already asking you about another step from this computer.`,
  notReady: (name: string) => `${name} has not read its own set-up yet: open Connections there.`,
  kind: 'Only MCP servers’ and Claude settings files’ values can be copied. Sign-ins, keys and .env files are made or typed on each computer.',
  noStep: (name: string, lineId: string) => {
    const step = copyStepOf(lineId);
    return step?.kind === 'mcp' ? `${name} has no MCP server called ${step.server}.` : step?.kind === 'settings' ? `${name} has no settings file at ${step.path}.` : VALUE_WORDS.kind;
  },
  noName: (name: string, step: string, value: string) => `${step} on ${name} has no value called ${value}.`,
  withdrawn: 'The request was withdrawn.',
} as const;

/** A request's step as the card names it: "MCP server home-assistant", "Claude settings file ~/.claude/settings.json". Pure. */
export function stepText(lineId: string): string {
  const step = copyStepOf(lineId);
  if (step?.kind === 'mcp') return `MCP server ${step.server}`;
  if (step?.kind === 'settings') return `Claude settings file ${step.path}`;
  return lineId;
}

/** A request waiting on this computer's person, as the window shows it. Names, never values. */
export interface ValueRequestView {
  id: string;
  /** The asking computer, named as its keyring entry names it. */
  from: { id: string; name: string };
  line: string;
  step: string;
  names: string[];
  /** Where the values would be read from here, in words. */
  source: string;
  expiresAt: number;
}

/** One entry of what this computer sent (19.14). Names only: there is no field a value could go in. */
export interface SentEntry {
  at: number;
  to: { id: string; name: string };
  line: string;
  step: string;
  names: string[];
  notThere: string[];
}

/** The record with one more entry, newest first, at most `SENT_MAX`. Pure. */
export const withSent = (list: readonly SentEntry[], entry: SentEntry): SentEntry[] => [entry, ...list].slice(0, SENT_MAX);

const isNames = (v: unknown): v is string[] => Array.isArray(v) && v.every((n) => typeof n === 'string' && VALUE_NAME.test(n));

/** A stored record read back: anything malformed is dropped, and nothing but the known fields is kept. Pure. */
export function asSentList(raw: unknown): SentEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .flatMap((e): SentEntry[] => {
      const r = (typeof e === 'object' && e !== null ? e : {}) as Record<string, unknown>;
      const to = (typeof r.to === 'object' && r.to !== null ? r.to : {}) as Record<string, unknown>;
      if (typeof r.at !== 'number' || typeof to.id !== 'string' || typeof to.name !== 'string' || typeof r.line !== 'string' || typeof r.step !== 'string' || !isNames(r.names) || !isNames(r.notThere)) return [];
      return [{ at: r.at, to: { id: to.id, name: to.name }, line: r.line, step: r.step, names: r.names, notThere: r.notThere }];
    })
    .slice(0, SENT_MAX);
}

/** One row of Settings → Connections' list. Pure. */
export const sentRowText = (entry: SentEntry): string => `${entry.to.name}, for ${entry.step}: ${entry.names.join(', ')}`;

/** What the answering computer sent back. */
export interface ValuesAnswer {
  values: Record<string, string>;
  notThere: string[];
}

/**
 * The answer checked against what was asked: every name asked for is either a value or not there, no name
 * that was not asked for, each value text of at most `VALUE_MAX`. The problem in words (never quoting a
 * value) when it is not. Pure.
 */
export function checkValuesAnswer(asked: readonly string[], raw: unknown): { ok: true; answer: ValuesAnswer } | { ok: false; problem: string } {
  const bad = { ok: false as const, problem: 'The other computer answered with something that is not the values asked for. Nothing was written.' };
  const r = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : null) as Record<string, unknown> | null;
  if (!r) return bad;
  const values = (typeof r.values === 'object' && r.values !== null && !Array.isArray(r.values) ? r.values : null) as Record<string, unknown> | null;
  if (!values || !Array.isArray(r.notThere)) return bad;
  const names = Object.keys(values);
  const notThere = r.notThere;
  if (notThere.some((n) => typeof n !== 'string' || !asked.includes(n))) return bad;
  const stray = names.find((n) => !asked.includes(n));
  if (stray) return { ok: false, problem: `The other computer sent ${stray}, which was not asked for. Nothing was written.` };
  const long = names.find((n) => typeof values[n] !== 'string' || (values[n] as string).length === 0 || (values[n] as string).length > VALUE_MAX);
  if (long) return { ok: false, problem: `The value for ${long} is not text of at most ${VALUE_MAX} characters. Nothing was written.` };
  if (asked.some((n) => !names.includes(n) && !notThere.includes(n))) return bad;
  return { ok: true, answer: { values: values as Record<string, string>, notThere: notThere as string[] } };
}
