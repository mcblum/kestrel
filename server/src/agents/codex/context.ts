// How full a Codex thread's context window is. Codex reports it after each model response as the
// `thread/tokenUsage/updated` notification (codex-cli 0.167, `ThreadTokenUsage`): `last` is the
// usage of the latest request, whose total is what the conversation now occupies, and
// `modelContextWindow` is the window. The handle keeps the latest report and sends it as the
// `context` event when a turn ends. Codex gives totals only, so the rows are just used and free.
// Pure.
import type { ContextUsage } from '../../shared/context-usage.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** A `ThreadTokenUsage` as Kestrel's; null when it names no window (nothing to draw a ring against). */
export function toContextUsage(tokenUsage: unknown, model: string, at = Date.now()): ContextUsage | null {
  if (!isObj(tokenUsage) || !isObj(tokenUsage.last)) return null;
  const windowTokens = count(tokenUsage.modelContextWindow);
  if (!windowTokens) return null;
  const usedTokens = count(tokenUsage.last.totalTokens);
  return {
    model,
    usedTokens,
    windowTokens,
    rows: [
      { name: 'Conversation', tokens: usedTokens, kind: 'used' },
      { name: 'Free space', tokens: Math.max(0, windowTokens - usedTokens), kind: 'free' },
    ],
    at,
  };
}
