// Bringing another computer's model presets and Who does what here (docs/designs/onboarding.md, 19): a
// merge, never a replacement. A preset this computer lacks is added under an id of its own; a role,
// its reviewers, fallbacks or the Orchestrate choice is set only where this computer has none, with
// the other's preset ids turned into this computer's; the note on who does what only where there is
// none here. Nothing this computer already has is changed. One function decides it, for the set-up
// list's line (what Run would do, and whether it is done) and for the step itself. Pure.
import { MAX_PRESETS, modeOfRole, NOBODY, ROLE_ROWS, ROW_LABEL, rowList, withRowList, type ModelPreset, type RoleRow, type WhoDoesWhat } from './who-does-what.ts';

export interface WhoDoesWhatMerge {
  /** The record to store here. */
  who: WhoDoesWhat;
  /** The other's presets added here, with this computer's ids. */
  added: ModelPreset[];
  /** The rows (Orchestrate, Design, Build, Review) set here because this computer had none. */
  rows: RoleRow[];
  /** The note on who does what was copied: there was none here. */
  instruction: boolean;
  /** The other's presets that did not fit under `MAX_PRESETS`, by name. */
  leftOut: string[];
  /** The other's presets whose name a different preset here already has: this computer's is kept. By name. */
  keptYours: string[];
}

const nameKey = (name: string): string => name.trim().toLowerCase();
/** One preset, the same on two computers: name, agent, model, effort and fast mode. Ids differ between computers. */
export const samePreset = (a: ModelPreset, b: ModelPreset): boolean => nameKey(a.name) === nameKey(b.name) && a.agent === b.agent && a.model === b.model && a.effort === b.effort && a.fast === b.fast;

/** `here` with what `other` has and this computer lacks. `newId` names an added preset; a taken id gets a suffix. */
export function mergeWhoDoesWhat(here: WhoDoesWhat, other: WhoDoesWhat, newId: () => string): WhoDoesWhatMerge {
  const ids = new Map<string, string>();
  const presets = [...here.presets];
  const taken = new Set(presets.map((p) => p.id));
  const added: ModelPreset[] = [];
  const leftOut: string[] = [];
  const keptYours: string[] = [];
  for (const preset of other.presets) {
    const same = presets.find((p) => samePreset(p, preset));
    if (same) {
      ids.set(preset.id, same.id);
      continue;
    }
    if (presets.some((p) => nameKey(p.name) === nameKey(preset.name))) {
      keptYours.push(preset.name);
      continue;
    }
    if (presets.length >= MAX_PRESETS) {
      leftOut.push(preset.name);
      continue;
    }
    const base = newId() || 'preset';
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    taken.add(id);
    const copy = { ...preset, id };
    presets.push(copy);
    added.push(copy);
    ids.set(preset.id, id);
  }

  let who: WhoDoesWhat = { ...here, presets };
  const rows: RoleRow[] = [];
  for (const row of ROLE_ROWS) {
    if (rowList(here, row).length > 0) continue;
    const mapped = rowList(other, row).flatMap((id) => (ids.has(id) ? [ids.get(id)!] : []));
    if (mapped.length === 0) continue;
    who = withRowList(who, row, mapped);
    rows.push(row);
    // How a role's work is sent comes with the role: the other's choice for the row it brings.
    if (row !== 'orchestrate') who = { ...who, modes: { ...(who.modes ?? NOBODY.modes!), [row]: modeOfRole(other, row) } };
  }
  // Whether to ask before a role's work goes to its next choice, and whether reviews are offered or start on
  // their own, belong to the rows they shape: taken only when those rows came from the other computer.
  const hadWorkRows = rowList(here, 'design').length > 0 || rowList(here, 'build').length > 0;
  if (!hadWorkRows && (rows.includes('design') || rows.includes('build'))) who = { ...who, whenUnavailable: other.whenUnavailable ?? 'ask' };
  if (rows.includes('review')) {
    who = { ...who, reviewOffer: other.reviewOffer !== false, reviewAuto: other.reviewAuto === true };
  }
  const instruction = here.instruction.trim() === '' && other.instruction.trim() !== '';
  if (instruction) who = { ...who, instruction: other.instruction };
  return { who, added, rows, instruction, leftOut, keptYours };
}

/** Whether the merge changes anything here. */
export const mergeChanges = (m: Pick<WhoDoesWhatMerge, 'added' | 'rows' | 'instruction'>): boolean => m.added.length > 0 || m.rows.length > 0 || m.instruction;

/** Nothing left to bring: nothing would change and nothing is left out for want of room. A name kept here counts as here. */
export const mergeDone = (m: WhoDoesWhatMerge): boolean => !mergeChanges(m) && m.leftOut.length === 0;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
/** "A", "A and B", "A, B and C". */
export const andList = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
/** Clauses of a sentence: "a and b", "a, b, and c" (each may hold a list of its own). */
const clauses = (parts: readonly string[]): string => (parts.length <= 2 ? parts.join(' and ') : `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`);
const quoted = (names: readonly string[]): string => andList(names.map((n) => `"${n}"`));

/** What is not brought, and why, in sentences; '' when everything is. */
export function mergeLeftText(m: Pick<WhoDoesWhatMerge, 'leftOut' | 'keptYours'>): string {
  const kept = m.keptYours.length > 0 ? ` ${quoted(m.keptYours)} ${m.keptYours.length === 1 ? 'is' : 'are'} here under the same name with other settings, and this computer's ${m.keptYours.length === 1 ? 'is' : 'are'} kept.` : '';
  const left = m.leftOut.length > 0 ? ` ${quoted(m.leftOut)} ${m.leftOut.length === 1 ? 'does' : 'do'} not fit: there can be at most ${MAX_PRESETS} presets.` : '';
  return `${kept}${left}`;
}

/** What Run will do, as one sentence of verbs: "Adds 2 presets ("A" and "B") and sets Design and Review". '' when nothing. */
export function mergeDoesText(m: Pick<WhoDoesWhatMerge, 'added' | 'rows' | 'instruction'>): string {
  const parts = [
    m.added.length > 0 && `adds ${plural(m.added.length, 'preset')} this computer lacks (${quoted(m.added.map((p) => p.name))})`,
    m.rows.length > 0 && `sets ${andList(m.rows.map((r) => ROW_LABEL[r]))} where none is set here`,
    m.instruction && 'copies the note on who does what',
  ].filter((p): p is string => typeof p === 'string');
  const text = clauses(parts);
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

/** What the step did, for its line and toast. */
export function mergeSaidText(m: WhoDoesWhatMerge): string {
  const did = [
    m.added.length > 0 && `added ${plural(m.added.length, 'preset')} (${quoted(m.added.map((p) => p.name))})`,
    m.rows.length > 0 && `set ${andList(m.rows.map((r) => ROW_LABEL[r]))}`,
    m.instruction && 'copied the note on who does what',
  ].filter((p): p is string => typeof p === 'string');
  const text = did.length > 0 ? `${clauses(did)}.` : 'nothing was missing here.';
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}${mergeLeftText(m)}`;
}
