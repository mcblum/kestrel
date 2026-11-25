// The model, effort and fast-mode choice under the message box, as data. Pure; shared by the UI's
// model menu and its tests. What a model supports comes from the agent (ModelOption: `efforts`,
// `fast`, `resolves`), never from a list of names kept here.
//
// Which models are "current" (listed first, numbered) and which go under "More models" is derived
// from the agent's own list: models are grouped into families by their name with the version
// number and any bracketed note taken out ("Opus 5.5" → opus, "GPT-6.1-Sol" → gpt sol, so Codex's
// Sol, Terra and Luna lines are families of their own), and the highest version in each family is
// current. Entries that stand for
// the same model (an alias and its full id) are listed once. The agent's "Default" entry (id '')
// is a row of its own, named for the model it stands for, unless another row is that same model.
import type { ModelOption } from '../agents/types.ts';
import type { MenuItem } from './menu.ts';

export interface ModelSettings {
  /** Empty means the agent's default. */
  model: string;
  /** Empty or absent means the model's own default effort. */
  effort?: string;
  fast?: boolean;
}

/**
 * Whether a saved model name is one the agent does not list now: the agent answered for itself
 * (`fromSdk`), the name is not its default (''), and no entry has it as its id or stands for it.
 * A name saved under one sign-in can stop being offered under another (Codex through a cloud
 * provider names models `openai.…`; a ChatGPT sign-in takes the plain names), and a session
 * started on it fails. False while the agent has not answered: nothing is known then.
 */
export function modelNotListed(models: readonly Pick<ModelOption, 'id' | 'resolves'>[], fromSdk: boolean, model: string): boolean {
  return fromSdk && model !== '' && !models.some((m) => m.id === model || m.resolves === model);
}

const EFFORT_LABEL: Record<string, string> = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

export const effortLabel = (effort: string): string => EFFORT_LABEL[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);

const VERSION = /(\d+(?:\.\d+)?)/;

/** The model's line: its name without the version or a bracketed note, in lower-case words. */
export function family(label: string): string {
  const words = label.replace(/\([^)]*\)/g, ' ').replace(VERSION, ' ').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.join(' ') || label.trim().toLowerCase();
}
const version = (m: ModelOption) => {
  const found = VERSION.exec(m.label.replace(/\([^)]*\)/g, ' '));
  return found ? Number(found[1]) : Number.NEGATIVE_INFINITY;
};

const MODEL_ID = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?!\d)/i;
const NAMED = /^[A-Z][A-Za-z]+ \d+(?:\.\d+)?$/;

/**
 * What to call the agent's default when it is a row of its own: the model it stands for, read from
 * its description ("Opus 5.5 · Best for…") or from the id it resolves to (a provider's own id such
 * as a Bedrock one still carries "claude-opus-5-5"), else "Default".
 */
export function defaultName(option: ModelOption): string {
  const lead = (option.description ?? '').split('·')[0]!.trim();
  if (NAMED.test(lead)) return lead;
  // "Use the default model (currently Opus 5.5)"
  const currently = /\(currently ([A-Z][A-Za-z]+ \d+(?:\.\d+)?)\)/.exec(option.description ?? '');
  if (currently) return currently[1]!;
  const id = MODEL_ID.exec(option.resolves ?? '');
  if (!id) return 'Default';
  const name = id[1]!.charAt(0).toUpperCase() + id[1]!.slice(1).toLowerCase();
  return `${name} ${id[2]}${id[3] ? `.${id[3]}` : ''}`;
}

/**
 * The rows the menu can show, in the agent's order. The agent's default (id '') is left out only
 * when another row stands for the very same model (then that row is ticked for it). Otherwise it
 * is a row of its own, first, named for the model it stands for: on a provider where the aliases
 * point elsewhere (Bedrock: "opus" may be an older Opus the account has not enabled) the default
 * is the one model that is sure to work, and it must be possible to choose it and to go back to it.
 * Other entries that stand for one model (an alias and its full id) are listed once.
 */
function rowsOf(models: readonly ModelOption[]): ModelOption[] {
  const base = models.find((m) => m.id === '');
  const others = models.filter((m) => m.id !== '');
  const stoodFor = base?.resolves !== undefined && others.some((m) => m.resolves === base.resolves);
  const seen = new Set<string>();
  const rows = others.filter((m) => {
    const key = m.resolves ?? m.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return base && !stoodFor ? [{ ...base, label: defaultName(base) }, ...rows] : rows;
}

/** The agent's list split into the current models (newest of each family, in the agent's order) and the rest. */
export function splitModels(models: readonly ModelOption[]): { current: ModelOption[]; more: ModelOption[] } {
  const rows = rowsOf(models);
  // The default's row: its own, or the row that stands for the same model (a configured GPT-6-Astra
  // while GPT-6.2-Astra is listed). It is the current one of its line, never pushed under More
  // models by a row that only looks newer.
  const defaultId = rowFor(models, '')?.id;
  const isDefault = (m: ModelOption) => m.id === defaultId;
  const newest = new Map<string, ModelOption>();
  for (const m of rows) {
    const best = newest.get(family(m.label));
    if (!best || (!isDefault(best) && (isDefault(m) || version(m) > version(best)))) newest.set(family(m.label), m);
  }
  const current = rows.filter((m) => newest.get(family(m.label)) === m);
  return { current, more: rows.filter((m) => !current.includes(m)) };
}

/** The entry a model id means: the agent's default for '', the entry itself otherwise. */
export const optionFor = (models: readonly ModelOption[], id: string): ModelOption | undefined => models.find((m) => m.id === id);

/** The row a model id is shown as: the default is the row that stands for the same model, or its own named row. */
function rowFor(models: readonly ModelOption[], id: string): ModelOption | undefined {
  const option = optionFor(models, id);
  if (id !== '' || !option) return option;
  const same = option.resolves === undefined ? undefined : models.find((m) => m.id !== '' && m.resolves === option.resolves);
  return same ?? rowsOf(models).find((m) => m.id === '') ?? option;
}

/** The menu's rows in its order: the current models, then those under "More models" (`more`). For a list shown elsewhere (a phone's New session). */
export function menuRows(models: readonly ModelOption[]): { option: ModelOption; more: boolean }[] {
  const { current, more } = splitModels(models);
  return [...current.map((option) => ({ option, more: false })), ...more.map((option) => ({ option, more: true }))];
}

/** The id of the menu row a model id is ticked as; undefined when no row stands for it (not listed). */
export function rowIdFor(models: readonly ModelOption[], id: string): string | undefined {
  const rows = rowsOf(models);
  const row = rowFor(models, id);
  if (row && rows.some((r) => r.id === row.id)) return row.id;
  const resolves = row?.resolves ?? id;
  return rows.find((r) => r.resolves !== undefined && r.resolves === resolves)?.id;
}

/** What the row under the message box says for a model. */
export function modelLabel(models: readonly ModelOption[], id: string): string {
  return rowFor(models, id)?.label ?? (id || 'Default');
}

/** Is this row the session's model? The default counts as the row it resolves to. */
const isChosen = (models: readonly ModelOption[], row: ModelOption, id: string) => row.id === id || (id === '' && rowFor(models, '')?.id === row.id);

/**
 * The settings with what the model cannot take left out: an effort it does not list, fast mode
 * when it has none. Used when the model changes and to show the row; an unknown model (the list
 * has not arrived) keeps everything, since there is nothing to judge by.
 */
export function fitToModel(models: readonly ModelOption[], s: ModelSettings): ModelSettings {
  const option = optionFor(models, s.model);
  if (!option) return s;
  const effort = s.effort && option.efforts?.includes(s.effort) ? s.effort : '';
  return { model: s.model, effort, fast: option.fast ? s.fast === true : false };
}

/** The effort shown beside the model in the row; null when there is nothing to show. */
export function shownEffort(models: readonly ModelOption[], s: ModelSettings): string | null {
  const fitted = fitToModel(models, s);
  return fitted.effort ? effortLabel(fitted.effort) : null;
}

const MAX_SHORTCUTS = 9;

const modelRow = (models: readonly ModelOption[], row: ModelOption, id: string, shortcut?: number): MenuItem => ({
  id: `model:${row.id}`,
  label: row.label,
  checked: isChosen(models, row, id),
  ...(shortcut !== undefined && shortcut <= MAX_SHORTCUTS ? { shortcut: String(shortcut) } : {}),
});

/** The model menu: current models (numbered), Effort and More models submenus, the fast-mode switch. */
export function modelMenu(models: readonly ModelOption[], s: ModelSettings): MenuItem[] {
  const { current, more } = splitModels(models);
  const option = optionFor(models, s.model);
  const fitted = fitToModel(models, s);
  const items: MenuItem[] = current.map((row, i) => modelRow(models, row, s.model, i + 1));
  const efforts = option?.efforts ?? [];
  const grouped: MenuItem[] = [];
  if (efforts.length > 0) {
    grouped.push({
      id: 'effort',
      label: 'Effort',
      value: fitted.effort ? effortLabel(fitted.effort) : 'Default',
      children: [{ id: 'effort:', label: 'Default', checked: !fitted.effort }, ...efforts.map((e) => ({ id: `effort:${e}`, label: effortLabel(e), checked: fitted.effort === e }))],
    });
  }
  if (more.length > 0) grouped.push({ id: 'more-models', label: 'More models', children: more.map((row) => modelRow(models, row, s.model)) });
  if (grouped[0] && items.length > 0) grouped[0] = { ...grouped[0], separatorBefore: true };
  items.push(...grouped);
  if (option?.fast) items.push({ id: 'fast', label: 'Enable fast mode', toggle: true, checked: fitted.fast === true, heading: 'Fast mode', separatorBefore: items.length > 0 });
  return items;
}

/** The settings after picking an item of `modelMenu`; unchanged for an id it does not know. */
export function pickFromMenu(models: readonly ModelOption[], s: ModelSettings, itemId: string): ModelSettings {
  if (itemId.startsWith('model:')) return fitToModel(models, { ...s, model: itemId.slice('model:'.length) });
  if (itemId.startsWith('effort:')) return { ...s, effort: itemId.slice('effort:'.length) };
  if (itemId === 'fast') return { ...s, fast: !s.fast };
  return s;
}
