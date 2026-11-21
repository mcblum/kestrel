// Two rules of the model picker under the message box that sit on top of model-choice.ts and
// sticky-controls.ts. Pure; shared by the UI and its tests.
//
// - Switching the agent of a new-session draft lands on the model, effort, fast mode and mode
//   remembered for that agent (the last ones picked by hand on it, sticky-controls.ts), not on the
//   agent's own default: Claude → Codex → Claude comes back to the model it had, and a fresh draft
//   on an agent draws what switching to it draws.
// - The model in use is always on the menu's first level, ticked. modelMenu lists the newest model
//   of each line first and the older ones under More models; a session on an older one (Codex's
//   Default standing for a configured GPT-6-Astra while GPT-6.2-Astra is newer) showed no tick at
//   all until More models was opened. Which row is the one in use is still decided only by
//   modelMenu (its `checked`); this only lifts that row up.
import type { ModelOption } from '../agents/types.ts';
import type { Agent } from '../model.ts';
import type { MenuItem } from './menu.ts';
import { modelMenu, type ModelSettings } from './model-choice.ts';
import { choicesFor, type Remembered } from './sticky-controls.ts';
import type { Controls } from './tabs.ts';

const MORE_MODELS = 'more-models';
const MAX_SHORTCUTS = 9;

/** A draft's controls after switching to `agent`: that agent's remembered set, else its defaults. */
export function switchAgent(value: Controls, agent: Agent, remembered: Remembered): Controls {
  return { ...value, agent, ...choicesFor(remembered, agent) };
}

const isModelRow = (item: MenuItem) => item.id.startsWith('model:');

/** The model menu as drawn: modelMenu, with the ticked model moved out of More models when it is there. */
export function shownModelMenu(models: readonly ModelOption[], s: ModelSettings): MenuItem[] {
  const items = modelMenu(models, s);
  if (items.some((i) => isModelRow(i) && i.checked)) return items;
  const more = items.find((i) => i.id === MORE_MODELS);
  const chosen = more?.children?.find((c) => c.checked);
  if (!more || !chosen) return items;
  const rows = items.filter(isModelRow).length;
  const number = rows + 1;
  const lifted: MenuItem = number <= MAX_SHORTCUTS ? { ...chosen, shortcut: String(number) } : chosen;
  const left = more.children!.filter((c) => c !== chosen);
  const rest = items.slice(rows).flatMap((i) => (i !== more ? [i] : left.length > 0 ? [{ ...more, children: left }] : []));
  return [...items.slice(0, rows), lifted, ...rest];
}
