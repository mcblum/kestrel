// Claude's plan usage and a run's tokens, as Kestrel's (shared/plan-usage.ts). Three sources, all the
// SDK's own (0.3.322), none asking the provider with a token Kestrel reads:
// - `rate_limit_event` on the stream as a turn runs: `rate_limit_info` names one window
//   (`rateLimitType`, `utilization` 0-1, `resetsAt` in seconds, `status`); the CLI also sends
//   `unifiedWindows`, every window it knows from the response, which the SDK's types do not list yet
//   (seen in a captured run: fixtures/write-approval.jsonl). Both are read; a window in both is one.
// - the experimental `/usage` query (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`), asked
//   once as a turn ends while its query is open, `skipBehaviors`: every window, 0-100, ISO resets, the
//   plan, and `rate_limits_available: false` for an API key or a cloud provider. The SDK says it may
//   change or go: it is only ever additive, checked field by field, and its absence costs nothing.
// - the result message's `modelUsage`: a run's tokens per model (cumulative over the run, as its cost is).
// Pure, apart from the ask.
import type { PlanUsage, LimitWindow, TurnTokens } from '../../shared/plan-usage.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** What Claude Code's own /usage screen calls each window, in its order. */
const WINDOWS: Record<string, { label: string; order: number }> = {
  five_hour: { label: '5-hour', order: 0 },
  seven_day: { label: 'Weekly', order: 1 },
  seven_day_opus: { label: 'Weekly (Opus)', order: 2 },
  seven_day_sonnet: { label: 'Weekly (Sonnet)', order: 3 },
  seven_day_oauth_apps: { label: 'Weekly (apps)', order: 4 },
  overage: { label: 'Extra usage', order: 9 },
};
/** Not a limit of its own: the share of extra usage a weekly window includes. */
const SKIPPED = new Set(['seven_day_overage_included']);

const windowOf = (id: string, usedPercent: number | null, resetsAt: number | null, reached: boolean): LimitWindow => {
  const known = WINDOWS[id] ?? { label: id.replace(/_/g, ' '), order: 8 };
  return { id, label: known.label, usedPercent, resetsAt, order: known.order, ...(reached ? { reached: true } : {}) };
};

/** Seconds since 1970 as ms; null when not a time. */
const fromSeconds = (v: unknown): number | null => {
  const s = num(v);
  return s !== null && s > 0 ? s * 1000 : null;
};

/** A share given as 0-1 as a percent. */
const fromFraction = (v: unknown): number | null => {
  const f = num(v);
  return f === null ? null : f * 100;
};

/** A `rate_limit_event` message as a report; null when it names no window. */
export function limitsFromEvent(message: unknown, at = Date.now()): PlanUsage | null {
  const info = isObj(message) && isObj(message.rate_limit_info) ? message.rate_limit_info : null;
  if (!info) return null;
  const windows = new Map<string, LimitWindow>();
  const type = typeof info.rateLimitType === 'string' ? info.rateLimitType : '';
  if (type && !SKIPPED.has(type)) windows.set(type, windowOf(type, fromFraction(info.utilization), fromSeconds(info.resetsAt), info.status === 'rejected'));
  if (isObj(info.unifiedWindows)) {
    for (const [id, w] of Object.entries(info.unifiedWindows)) {
      if (!isObj(w) || SKIPPED.has(id)) continue;
      const before = windows.get(id);
      windows.set(id, windowOf(id, fromFraction(w.utilization) ?? before?.usedPercent ?? null, fromSeconds(w.resetsAt) ?? before?.resetsAt ?? null, w.status === 'rejected' || (before?.reached ?? false)));
    }
  }
  if (windows.size === 0) return null;
  return { windows: [...windows.values()], at };
}

/** The experimental /usage answer as a report; null when it is not one Kestrel can read. */
export function limitsFromUsageReport(answer: unknown, at = Date.now()): PlanUsage | null {
  if (!isObj(answer)) return null;
  const plan = typeof answer.subscription_type === 'string' && answer.subscription_type ? { plan: answer.subscription_type } : {};
  if (answer.rate_limits_available === false) return { windows: [], at, noLimits: true, ...plan };
  const limits = isObj(answer.rate_limits) ? answer.rate_limits : null;
  if (!limits) return null;
  const windows: LimitWindow[] = [];
  const iso = (v: unknown) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
  for (const id of Object.keys(WINDOWS)) {
    const w = limits[id];
    if (isObj(w) && (num(w.utilization) !== null || iso(w.resets_at) !== null)) windows.push(windowOf(id, num(w.utilization), iso(w.resets_at), false));
  }
  for (const w of Array.isArray(limits.model_scoped) ? limits.model_scoped : []) {
    if (!isObj(w) || typeof w.display_name !== 'string' || !w.display_name) continue;
    const id = `seven_day_${w.display_name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
    if (windows.some((x) => x.id === id)) continue;
    windows.push({ id, label: `Weekly (${w.display_name})`, usedPercent: num(w.utilization), resetsAt: iso(w.resets_at), order: 5 });
  }
  if (windows.length === 0) return null;
  return { windows, at, ...plan };
}

/** A result message's tokens over every model of the run: input with cache reads and writes, output with thinking. */
export function tokensFromResult(message: unknown): TurnTokens | undefined {
  const models = isObj(message) && isObj(message.modelUsage) ? message.modelUsage : null;
  if (!models) return undefined;
  let input = 0;
  let output = 0;
  for (const u of Object.values(models)) {
    if (!isObj(u)) continue;
    input += (num(u.inputTokens) ?? 0) + (num(u.cacheReadInputTokens) ?? 0) + (num(u.cacheCreationInputTokens) ?? 0);
    output += num(u.outputTokens) ?? 0;
  }
  return input + output > 0 ? { input, output } : undefined;
}

/** The experimental /usage method, where this SDK has it. */
type UsageAsker = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (opts?: { skipBehaviors?: boolean }) => Promise<unknown> };

/** Ask a live query for the plan's windows, giving up after `ms`; null when it cannot say. Never throws. */
export async function askPlanUsage(q: unknown, ms: number): Promise<PlanUsage | null> {
  const ask = (q as UsageAsker | null)?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
  if (typeof ask !== 'function') return null;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref();
  });
  try {
    return limitsFromUsageReport(await Promise.race([ask.call(q, { skipBehaviors: true }), late]));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
