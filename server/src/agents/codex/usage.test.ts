// Codex's plan usage and tokens. The token reports are captured (fixtures/chat.jsonl, codex-cli 0.167); the rate-limit
// shapes follow the installed codex-cli 0.167.2's own schema (`codex app-server generate-ts`: RateLimitSnapshot,
// GetAccountRateLimitsResponse, AccountRateLimitsUpdatedNotification), as no captured run carried one.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { addRequestTokens, limitsFromNotification, limitsFromRead, windowLabel } from './usage.ts';

const AT = 1_795_000_000_000;
const lines = readFileSync(new URL('./fixtures/chat.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { msg: { method?: string; params?: Record<string, unknown> } });

const snapshot = {
  limitId: 'codex',
  limitName: null,
  normalModelSlug: null,
  primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1_795_010_000 },
  secondary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 1_795_400_000 },
  credits: null,
  individualLimit: null,
  spendControlReached: null,
  planType: 'plus',
  rateLimitReachedType: null,
};

describe("a turn's tokens", () => {
  it("are the sum of its requests' last, which is what the thread's total grew by", () => {
    const thread = lines.map((l) => l.msg).filter((m) => m.method === 'thread/tokenUsage/updated').map((m) => m.params!);
    const first = thread[0]!.threadId;
    const reports = thread.filter((p) => p.threadId === first).map((p) => p.tokenUsage as { total: { inputTokens: number; outputTokens: number } });
    const summed = reports.reduce((sum, u) => addRequestTokens(sum, u), null as ReturnType<typeof addRequestTokens>);
    const total = reports.at(-1)!.total;
    expect(summed).toEqual({ input: total.inputTokens, output: total.outputTokens });
  });

  it('ignores a report with no request in it', () => {
    expect(addRequestTokens(null, { total: {} })).toBeNull();
    expect(addRequestTokens({ input: 1, output: 1 }, { last: { inputTokens: 0, outputTokens: 0 } })).toEqual({ input: 1, output: 1 });
  });
});

describe('rate limits', () => {
  it('reads the snapshot: 5-hour and weekly, percent used, resets in seconds, the plan', () => {
    expect(limitsFromNotification({ rateLimits: snapshot }, AT)).toEqual({
      windows: [
        { id: 'primary', label: '5-hour', usedPercent: 37, resetsAt: 1_795_010_000_000, order: 0 },
        { id: 'secondary', label: 'Weekly', usedPercent: 12, resetsAt: 1_795_400_000_000, order: 1 },
      ],
      at: AT,
      plan: 'plus',
    });
  });

  it('takes a sparse update as only the windows it carries', () => {
    expect(limitsFromNotification({ rateLimits: { ...snapshot, secondary: null, planType: null } }, AT)?.windows.map((w) => w.id)).toEqual(['primary']);
    expect(limitsFromNotification({ rateLimits: { ...snapshot, primary: null, secondary: null } }, AT)).toBeNull();
  });

  it('marks the window used most as used up when Codex says a limit is reached', () => {
    const usage = limitsFromNotification({ rateLimits: { ...snapshot, primary: { ...snapshot.primary, usedPercent: 100 }, rateLimitReachedType: 'rate_limit_reached' } }, AT)!;
    expect(usage.windows.map((w) => [w.id, w.reached ?? false])).toEqual([
      ['primary', true],
      ['secondary', false],
    ]);
  });

  it("reads the read's main bucket and names any other metered bucket", () => {
    const usage = limitsFromRead({ ordinaryUsageAllowed: true, rateLimits: snapshot, rateLimitsByLimitId: { codex: snapshot, review: { ...snapshot, limitId: 'review', limitName: 'Code review', secondary: null } }, rateLimitResetCredits: null, accountId: null, rateLimitUpsell: null }, AT)!;
    expect(usage.windows.map((w) => [w.id, w.label])).toEqual([
      ['primary', '5-hour'],
      ['secondary', 'Weekly'],
      ['Code review:primary', '5-hour (Code review)'],
    ]);
  });

  it('names a window by its length', () => {
    expect([windowLabel(300, 'primary'), windowLabel(10_080, 'secondary'), windowLabel(1440, 'primary'), windowLabel(90, 'primary'), windowLabel(null, 'secondary')]).toEqual(['5-hour', 'Weekly', '1-day', '90-minute', 'Secondary']);
  });
});
