// OpenCode's models, as its server reports them (`provider.list` and `config.get`, opencode 1.14.25),
// for the controls under the message box. Pure; the probe asks (connect.ts).
//
// - Only providers OpenCode can use right now (`connected`: signed in, keyed, or free) are listed,
//   and of their models only the ones that can call tools (a coding agent needs them) and are not
//   deprecated: Groq's speech models, say, are left out.
// - A model's id is OpenCode's `provider/model`, which `session.promptAsync` takes split in two.
// - Effort: a model's `variants` (low, medium, high, max…), in OpenCode's order; sent back as the
//   prompt's `variant`. OpenCode has no fast mode.
// - Default ('') is the model in the user's OpenCode config when there is one, else OpenCode's own
//   choice (the model it last used, else a provider's default).
import type { ModelOption } from '../types.ts';

export const FALLBACK_MODELS: ModelOption[] = [{ id: '', label: 'Default', description: "The model set in your OpenCode config, else OpenCode's own choice" }];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** `provider/model` split as OpenCode's prompt takes it; null for anything else. */
export function splitModel(id: string): { providerID: string; modelID: string } | null {
  const cut = id.indexOf('/');
  if (cut <= 0 || cut === id.length - 1) return null;
  return { providerID: id.slice(0, cut), modelID: id.slice(cut + 1) };
}

const usable = (m: Obj): boolean => m.status !== 'deprecated' && (!isObj(m.capabilities) || m.capabilities.toolcall !== false);
const variantsOf = (m: Obj): string[] => (isObj(m.variants) ? Object.keys(m.variants) : []);

function option(provider: Obj, m: Obj): ModelOption {
  const id = `${str(provider.id)}/${str(m.id)}`;
  const efforts = variantsOf(m);
  return { id, label: str(m.name) || str(m.id), description: str(provider.name) || str(provider.id), ...(efforts.length ? { efforts } : {}), resolves: id };
}

/** The connected providers' usable models as picker entries, Default first. */
export function toOptions(listed: unknown, configured?: string | null): ModelOption[] {
  const answer = isObj(listed) ? listed : {};
  const connected = new Set(Array.isArray(answer.connected) ? answer.connected.filter((c): c is string => typeof c === 'string') : []);
  const providers = (Array.isArray(answer.all) ? answer.all : []).filter(isObj).filter((p) => connected.has(str(p.id)));
  const models = providers.flatMap((p) => (isObj(p.models) ? Object.values(p.models).filter(isObj).filter(usable).map((m) => option(p, m)) : []));
  if (models.length === 0) return FALLBACK_MODELS;
  const preferred = configured ? models.find((m) => m.id === configured) : undefined;
  const first: ModelOption = preferred
    ? { ...preferred, id: '', label: 'Default', description: `The model set in your OpenCode config: ${preferred.label}` }
    : FALLBACK_MODELS[0]!;
  return [first, ...models];
}

/** The providers OpenCode can use now, from `provider.list`. */
export function connectedProviders(listed: unknown): string[] {
  return isObj(listed) && Array.isArray(listed.connected) ? listed.connected.filter((c): c is string => typeof c === 'string') : [];
}

/** The model in a `config.get` answer, or null. */
export const configuredModel = (config: unknown): string | null => (isObj(config) && str(config.model) ? str(config.model) : null);

/** A model's context window in tokens, from `provider.list`; 0 when unknown. */
export function contextWindow(listed: unknown, id: string): number {
  const split = splitModel(id);
  if (!split || !isObj(listed) || !Array.isArray(listed.all)) return 0;
  const provider = listed.all.filter(isObj).find((p) => p.id === split.providerID);
  const model = provider && isObj(provider.models) ? provider.models[split.modelID] : undefined;
  const limit = isObj(model) && isObj(model.limit) ? model.limit.context : 0;
  return typeof limit === 'number' && limit > 0 ? limit : 0;
}
