// How full a session's context window is, as an agent reports it, and the small pure helpers the
// ring under the message box and its popup use. Provider-agnostic: an adapter turns its own report
// into a `ContextUsage` (Claude: agents/claude/context.ts).

/**
 * What a row is: `used` occupies the window; `free` is what is left; `buffer` is held back for
 * compaction; `deferred` is listed for awareness but is not in the window (tool schemas loaded on
 * demand). Only `used` rows count towards `usedTokens`.
 */
export type ContextRowKind = 'used' | 'free' | 'buffer' | 'deferred';

export interface ContextRow {
  name: string;
  tokens: number;
  kind: ContextRowKind;
}

export interface ContextUsage {
  /** The model the window belongs to, as the agent names it. */
  model: string;
  usedTokens: number;
  windowTokens: number;
  /** The breakdown, in the agent's order. May be empty when the agent gives only the totals. */
  rows: ContextRow[];
  /** When it was measured, ms since 1970. */
  at: number;
}

/** The share of the window in use, 0 to 1 (an over-full window reads as full). */
export function usedFraction(usage: ContextUsage): number {
  if (!(usage.windowTokens > 0)) return 0;
  return Math.min(1, Math.max(0, usage.usedTokens / usage.windowTokens));
}

/** Whole percent for the label; anything in use but under 1% reads as "<1%". */
export function percentLabel(usage: ContextUsage): string {
  const share = usage.windowTokens > 0 ? (usage.usedTokens / usage.windowTokens) * 100 : 0;
  if (share > 0 && share < 1) return '<1%';
  return `${Math.round(share)}%`;
}

/** A token count the way people say it: 950, 15.5k, 200k, 1M, 1.2M. */
export function tokenCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 100 ? Number(k.toFixed(1)) : Math.round(k)}k`;
  }
  return `${Number((n / 1_000_000).toFixed(1))}M`;
}

/** The rows worth showing: zero-token rows are dropped, the window's own rows (used, buffer, free) first, deferred last. */
export function shownRows(usage: ContextUsage): { inWindow: ContextRow[]; deferred: ContextRow[] } {
  const rows = usage.rows.filter((r) => r.tokens > 0);
  return { inWindow: rows.filter((r) => r.kind !== 'deferred'), deferred: rows.filter((r) => r.kind === 'deferred') };
}
