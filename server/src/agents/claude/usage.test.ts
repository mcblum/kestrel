// Claude's plan usage and tokens. The event and the result are from a captured run (fixtures/write-approval.jsonl,
// SDK 0.3.322); the /usage answer follows the SDK's own type (`SDKControlGetUsageResponse`), as no run asked it then.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ClaudeMapper } from './map.ts';
import { askPlanUsage, limitsFromEvent, limitsFromUsageReport, tokensFromResult } from './usage.ts';

const captured = readFileSync(new URL('./fixtures/write-approval.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const event = captured.find((m) => m.type === 'rate_limit_event')!;
const result = captured.find((m) => m.type === 'result')!;
const AT = 1_795_000_000_000;

describe('the captured rate_limit_event', () => {
  it('is the weekly window: 3% used (utilization 0.03), resetting at its time in seconds', () => {
    expect(limitsFromEvent(event, AT)).toEqual({ windows: [{ id: 'seven_day', label: 'Weekly', usedPercent: 3, resetsAt: 1_795_154_400_000, order: 1 }], at: AT });
  });

  it('reads every window of unifiedWindows, and one at its limit as used up', () => {
    const both = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1_795_010_000, unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1_795_010_000, status: 'rejected' }, seven_day: { utilization: 0.41, resetsAt: 1_795_154_400, status: 'allowed' }, seven_day_overage_included: { utilization: 0.1 } } } };
    const usage = limitsFromEvent(both, AT)!;
    expect(usage.windows.map((w) => [w.id, w.usedPercent, w.reached ?? false])).toEqual([
      ['five_hour', 100, true],
      ['seven_day', 41, false],
    ]);
  });

  it('is nothing when it names no window', () => {
    expect(limitsFromEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })).toBeNull();
    expect(limitsFromEvent({ type: 'rate_limit_event' })).toBeNull();
  });

  it('becomes a limits event in the mapper; nothing else of the run changes', () => {
    const mapper = new ClaudeMapper('/work/demo', []);
    expect(mapper.map(event as never)).toEqual([{ type: 'limits', usage: expect.objectContaining({ windows: [expect.objectContaining({ id: 'seven_day', usedPercent: 3 })] }) }]);
  });
});

describe("the captured result's tokens", () => {
  it('add every model: input with cache reads and writes, output with thinking', () => {
    // claude-haiku-5-5: 1221 in, 64617 cache read, 5428 cache write, 477 out.
    expect(tokensFromResult(result)).toEqual({ input: 1221 + 64_617 + 5428, output: 477 });
  });

  it('go with the done event, beside its cost', () => {
    const mapper = new ClaudeMapper('/work/demo', []);
    const done = mapper.map(result as never).find((e) => e.type === 'done');
    expect(done).toEqual({ type: 'done', reason: 'complete', costUsd: 0.00209237, tokens: { input: 71_266, output: 477 } });
  });
});

describe('the experimental /usage answer', () => {
  const answer = {
    session: { total_cost_usd: 0.4, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 42, resets_at: '2026-11-27T15:00:00Z' },
      seven_day: { utilization: 12.5, resets_at: '2026-12-01T09:00:00Z' },
      seven_day_opus: null,
      seven_day_sonnet: { utilization: null, resets_at: null },
      model_scoped: [{ display_name: 'Fable', utilization: 70, resets_at: '2026-12-01T09:00:00Z' }],
    },
    behaviors: null,
  };

  it('is every window with a figure, 0-100, ISO resets, and the plan', () => {
    const usage = limitsFromUsageReport(answer, AT)!;
    expect(usage.plan).toBe('max');
    expect(usage.windows.map((w) => [w.id, w.label, w.usedPercent, w.resetsAt])).toEqual([
      ['five_hour', '5-hour', 42, Date.parse('2026-11-27T15:00:00Z')],
      ['seven_day', 'Weekly', 12.5, Date.parse('2026-12-01T09:00:00Z')],
      ['seven_day_fable', 'Weekly (Fable)', 70, Date.parse('2026-12-01T09:00:00Z')],
    ]);
  });

  it('says no limits apply for an API key or a cloud provider', () => {
    expect(limitsFromUsageReport({ ...answer, subscription_type: null, rate_limits_available: false, rate_limits: null }, AT)).toEqual({ windows: [], at: AT, noLimits: true });
  });

  it('is nothing when the shape is not one Kestrel reads (the API may change)', () => {
    expect(limitsFromUsageReport({ rate_limits: 'soon' })).toBeNull();
    expect(limitsFromUsageReport(null)).toBeNull();
  });

  it('is asked only where the SDK has the method, and never throws', async () => {
    expect(await askPlanUsage({}, 50)).toBeNull();
    expect(await askPlanUsage({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => Promise.reject(new Error('gone')) }, 50)).toBeNull();
    expect(await askPlanUsage({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => new Promise(() => undefined) }, 20)).toBeNull();
    let asked: unknown;
    const q = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: (opts: unknown) => ((asked = opts), Promise.resolve(answer)) };
    expect((await askPlanUsage(q, 50))?.windows).toHaveLength(3);
    expect(asked).toEqual({ skipBehaviors: true });
  });
});
