// Codex's models, as `model/list` reports them, for the controls under the message box. Pure; the
// probe asks (connect.ts).
//
// What each entry offers comes from the same report (codex-cli 0.167 `Model`):
//   efforts  `supportedReasoningEfforts[].reasoningEffort`, in Codex's order (lowest first);
//            sent back as `turn/start`'s `effort`.
//   fast     a `serviceTiers` entry named "Fast" (id `priority` today); sent back as that tier's
//            id in `turn/start`'s `serviceTierForTurn`, and "default" when fast mode is off.
//   resolves the model's own id, so the Default entry (the model in the user's Codex config, else
//            the catalogue default) is shown as the model it is and offers what that model offers.
import type { ModelOption } from '../types.ts';

export const FALLBACK_MODELS: ModelOption[] = [{ id: '', label: 'Default', description: 'The model set in your Codex config, else Codex\'s own default' }];

/** The tier `serviceTierForTurn` takes for standard speed. */
export const STANDARD_TIER = 'default';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The model's fast service tier id, or null when it has none. */
export function fastTierOf(m: Obj): string | null {
  const tiers = Array.isArray(m.serviceTiers) ? m.serviceTiers.filter(isObj) : [];
  const fast = tiers.find((t) => /^fast$/i.test(str(t.name)) || str(t.id) === 'fast');
  return fast && str(fast.id) ? str(fast.id) : null;
}

const effortsOf = (m: Obj): string[] =>
  (Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : [])
    .map((e) => (isObj(e) ? str(e.reasoningEffort) : ''))
    .filter(Boolean);

const visible = (data: unknown): Obj[] => (Array.isArray(data) ? data : []).filter(isObj).filter((m) => m.hidden !== true && str(m.id));

const name = (m: Obj) => str(m.displayName) || str(m.id);

/**
 * The model Default stands for: the configured one, else the catalogue default. A configured model
 * Codex does not list is not known here, so Default then stands for nothing in particular.
 */
const preferredOf = (models: readonly Obj[], configured?: string | null) =>
  configured ? models.find((m) => str(m.id) === configured) : models.find((m) => m.isDefault === true);

function toOption(m: Obj, id: string, label: string, description: string): ModelOption {
  const efforts = effortsOf(m);
  return {
    id,
    label,
    ...(description ? { description } : {}),
    ...(efforts.length ? { efforts } : {}),
    ...(fastTierOf(m) ? { fast: true } : {}),
    resolves: str(m.id),
  };
}

/**
 * `model/list`'s `data` as picker entries: Default first (standing for `configured`, the model in
 * the user's Codex config, when Codex lists it, else the catalogue default), hidden models left out.
 */
export function toOptions(data: unknown, configured?: string | null): ModelOption[] {
  const models = visible(data);
  if (models.length === 0) return FALLBACK_MODELS;
  const preferred = preferredOf(models, configured);
  const catalogue = models.find((m) => m.isDefault === true);
  const description = catalogue ? `The model set in your Codex config, else ${name(catalogue)}` : FALLBACK_MODELS[0]!.description!;
  const first = preferred ? toOption(preferred, '', 'Default', description) : { id: '', label: 'Default', description };
  return [first, ...models.map((m) => toOption(m, str(m.id), name(m), str(m.description)))];
}

/** Each listed model's fast tier id (models without one are left out), and the Default's under ''. */
export function fastTiers(data: unknown, configured?: string | null): Record<string, string> {
  const models = visible(data);
  const out: Record<string, string> = {};
  for (const m of models) {
    const tier = fastTierOf(m);
    if (tier) out[str(m.id)] = tier;
  }
  const preferred = preferredOf(models, configured);
  const tier = preferred ? fastTierOf(preferred) : null;
  if (tier) out[''] = tier;
  return out;
}

/** The model in a `config/read` answer, or null. */
export function configuredModel(answer: unknown): string | null {
  return isObj(answer) && isObj(answer.config) && str(answer.config.model) ? str(answer.config.model) : null;
}
