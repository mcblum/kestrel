// The models Claude offers, asked of the SDK at runtime (so a new model appears without a
// Kestrel release), with a small fallback list when that call fails or takes too long.
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ModelOption } from '../types.ts';
import { configuredModel } from './configured-model.ts';
import { sideQueryOptions } from './side-query.ts';

export const FALLBACK_MODELS: ModelOption[] = [
  { id: '', label: 'Default' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
];

const TIMEOUT_MS = 20_000;

/** A prompt stream that never yields: enough for the SDK to start, so it can describe itself. */
async function* idle(): AsyncGenerator<never> {
  await new Promise<never>(() => undefined);
}

/** What the SDK says of one model (its ModelInfo), as far as Kestrel reads it. */
interface SdkModel {
  value: string;
  displayName: string;
  description?: string;
  resolvedModel?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: readonly string[];
  supportsFastMode?: boolean;
}

const VERSIONED = /^[A-Z][A-Za-z]+ \d+(?:\.\d+)?$/;
const MODEL_ID = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?!\d)/i;

/**
 * A model's name with its version. Some providers' lists name the newest of a line without one:
 * on Bedrock the SDK said "Opus" for Opus 5.5 and "Opus 5" for the one before, which read as if
 * Opus 5 were the newest and Opus 5.5 did not exist. The version is in the description
 * ("Opus 5.5 · Best for…") or in the model id; a name that already has one is left alone.
 */
export function properName(m: SdkModel): string {
  const name = m.displayName.trim();
  if (/\d/.test(name)) return name;
  const line = name.split(/\s+/)[0]!.toLowerCase();
  const lead = (m.description ?? '').split('·')[0]!.trim();
  if (VERSIONED.test(lead) && lead.toLowerCase().startsWith(line)) return lead;
  const id = MODEL_ID.exec(m.resolvedModel ?? m.value);
  if (id && id[1]!.toLowerCase() === line) return `${name} ${id[2]}${id[3] ? `.${id[3]}` : ''}`;
  return name;
}

/** One SDK model as a picker entry: its effort levels and fast mode only when the SDK says it has them. */
function toOption(m: SdkModel, id: string, label: string): ModelOption {
  const efforts = m.supportsEffort && m.supportedEffortLevels?.length ? [...m.supportedEffortLevels] : undefined;
  return {
    id,
    label,
    ...(m.description ? { description: m.description } : {}),
    ...(efforts ? { efforts } : {}),
    ...(m.supportsFastMode ? { fast: true } : {}),
    ...(m.resolvedModel ? { resolves: m.resolvedModel } : {}),
  };
}

/** An alias with a context-window note ("opus[1m]") is that alias. */
const aliasOf = (id: string) => id.replace(/\[[^\]]*\]$/, '');

/**
 * The SDK's list as picker entries. `configured` is the model the user's Claude settings name
 * (configured-model.ts): the default then stands for THAT model, not for what the SDK's list calls
 * its default. When the settings name one of the listed aliases the default is that row.
 */
export function toOptions(models: readonly SdkModel[], configured: string | null = null): ModelOption[] {
  const out: ModelOption[] = [{ id: '', label: 'Default' }];
  for (const m of models) {
    if (m.value === 'default') out[0] = toOption(m, '', 'Default');
    else out.push(toOption(m, m.value, properName(m)));
  }
  if (!configured) return out;
  const listed = out.find((m) => m.id !== '' && (m.id === configured || m.id === aliasOf(configured)));
  const { description: _dropped, ...base } = out[0]!;
  out[0] = listed
    ? { ...base, resolves: listed.resolves ?? listed.id, ...(listed.efforts ? { efforts: listed.efforts } : {}), ...(listed.fast ? { fast: true } : {}) }
    : { ...base, resolves: configured, description: `Set in your Claude settings: ${configured}` };
  return out;
}

export async function claudeModels(runQuery: typeof query = query): Promise<{ models: ModelOption[]; fromSdk: boolean }> {
  const q = runQuery({ prompt: idle() as never, options: sideQueryOptions() });
  const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), TIMEOUT_MS).unref());
  try {
    const found = await Promise.race([q.supportedModels(), timer]);
    if (found.length === 0) return { models: FALLBACK_MODELS, fromSdk: false };
    const configured = configuredModel();
    // In the log, so a menu that looks wrong on someone's setup can be explained from what Claude reported.
    console.log(`[kestrel] claude models: ${found.map((m) => `${m.value}=${m.displayName}${m.resolvedModel ? `→${m.resolvedModel}` : ''}`).join(', ')}${configured ? `; settings model: ${configured}` : ''}`);
    return { models: toOptions(found, configured), fromSdk: true };
  } catch {
    return { models: FALLBACK_MODELS, fromSdk: false };
  } finally {
    q.close();
  }
}
