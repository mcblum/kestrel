// Codex's plan usage and a turn's tokens, as Kestrel's (shared/plan-usage.ts). Both from the app-server's
// own protocol (codex-cli 0.167, `codex app-server generate-ts`), nothing asked with a token Kestrel reads:
// - `RateLimitSnapshot`: in `account/rateLimits/read`'s answer (asked once when a session's app-server
//   starts; it runs no turn) and in `account/rateLimits/updated` as turns run, which is sparse (a window
//   it leaves out is kept: plan-usage.ts `mergePlanUsage`). A `primary` and a `secondary` window, each
//   `usedPercent` 0-100, `windowDurationMins`, `resetsAt` in seconds; `planType`; `rateLimitReachedType`.
//   An API-key sign-in has no snapshot windows: nothing is shown then, and the note says so.
// - `thread/tokenUsage/updated`: `last` is one model request; a turn's tokens are the sum of its `last`s
//   (the thread's `total` grows by exactly that). `inputTokens` already counts the cached ones.
// Codex reports no cost in dollars (plan-usage.ts `REPORTS_COST`). Pure.
import { addTokens, type LimitWindow, type PlanUsage, type TurnTokens } from '../../shared/plan-usage.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** What Codex's own status line calls a window of this length: "5-hour", "Weekly"; else from its minutes. */
export function windowLabel(minutes: number | null, slot: 'primary' | 'secondary'): string {
  if (minutes === null) return slot === 'primary' ? 'Primary' : 'Secondary';
  if (minutes === 7 * 24 * 60) return 'Weekly';
  if (minutes === 30 * 24 * 60) return 'Monthly';
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

function windowOf(raw: unknown, slot: 'primary' | 'secondary', prefix: string, reached: boolean): LimitWindow | null {
  if (!isObj(raw)) return null;
  const used = num(raw.usedPercent);
  const resets = num(raw.resetsAt);
  const minutes = num(raw.windowDurationMins);
  const label = windowLabel(minutes, slot);
  return {
    id: `${prefix}${slot}`,
    label: prefix ? `${label} (${prefix.slice(0, -1)})` : label,
    usedPercent: used,
    resetsAt: resets !== null && resets > 0 ? resets * 1000 : null,
    order: slot === 'primary' ? 0 : 1,
    ...(reached || (used !== null && used >= 100) ? { reached: true } : {}),
  };
}

/** One `RateLimitSnapshot` as a report; null when it carries no window. `prefix` names a bucket other than the main one. */
export function limitsFromSnapshot(snapshot: unknown, at = Date.now(), prefix = ''): PlanUsage | null {
  if (!isObj(snapshot)) return null;
  const reached = typeof snapshot.rateLimitReachedType === 'string' && snapshot.rateLimitReachedType.length > 0;
  const windows = [windowOf(snapshot.primary, 'primary', prefix, false), windowOf(snapshot.secondary, 'secondary', prefix, false)].filter((w): w is LimitWindow => w !== null);
  // Codex says the account is at a limit without saying which window: the one used most carries it.
  if (reached && windows.length > 0) {
    const most = windows.reduce((a, b) => ((b.usedPercent ?? 0) > (a.usedPercent ?? 0) ? b : a));
    windows[windows.indexOf(most)] = { ...most, reached: true };
  }
  if (windows.length === 0) return null;
  const plan = typeof snapshot.planType === 'string' && snapshot.planType && snapshot.planType !== 'unknown' ? { plan: snapshot.planType } : {};
  return { windows, at, ...plan };
}

/** `account/rateLimits/updated`'s params as a report. */
export const limitsFromNotification = (params: unknown, at = Date.now()): PlanUsage | null => (isObj(params) ? limitsFromSnapshot(params.rateLimits, at) : null);

/** `account/rateLimits/read`'s answer as a report: the main bucket, then any other metered bucket (by `limitId`) under its own name. */
export function limitsFromRead(answer: unknown, at = Date.now()): PlanUsage | null {
  if (!isObj(answer)) return null;
  const main = limitsFromSnapshot(answer.rateLimits, at);
  const mainId = isObj(answer.rateLimits) && typeof answer.rateLimits.limitId === 'string' ? answer.rateLimits.limitId : 'codex';
  const others = isObj(answer.rateLimitsByLimitId) ? Object.entries(answer.rateLimitsByLimitId).filter(([id]) => id !== mainId) : [];
  const extra = others.flatMap(([id, snap]) => limitsFromSnapshot(snap, at, `${isObj(snap) && typeof snap.limitName === 'string' && snap.limitName ? snap.limitName : id}:`)?.windows ?? []);
  if (!main && extra.length === 0) return null;
  return { ...(main ?? { at, windows: [] }), windows: [...(main?.windows ?? []), ...extra.map((w) => ({ ...w, order: w.order + 10 }))] };
}

/** One `thread/tokenUsage/updated`'s request (`last`) added to a turn's tokens so far. */
export function addRequestTokens(before: TurnTokens | null, tokenUsage: unknown): TurnTokens | null {
  const last = isObj(tokenUsage) && isObj(tokenUsage.last) ? tokenUsage.last : null;
  if (!last) return before;
  const input = num(last.inputTokens) ?? 0;
  const output = num(last.outputTokens) ?? 0;
  if (input + output <= 0) return before;
  return addTokens(before, { input, output });
}
