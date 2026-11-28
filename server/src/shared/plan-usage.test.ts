import { describe, expect, it } from 'vitest';
import { addTokens, levelOf, mergePlanUsage, planNote, readout, realTokens, resetText, sameShown, tightestWindow, windowText, type LimitWindow, type PlanUsage } from './plan-usage.ts';
import { addTurnCost, spendText } from './details.ts';

const NOW = Date.UTC(2026, 10, 27, 12, 0);
const win = (id: string, usedPercent: number | null, resetsInMin: number | null, extra: Partial<LimitWindow> = {}): LimitWindow => ({ id, label: id === 'five_hour' ? '5-hour' : 'Weekly', usedPercent, resetsAt: resetsInMin === null ? null : NOW + resetsInMin * 60_000, order: id === 'five_hour' ? 0 : 1, ...extra });
const report = (windows: LimitWindow[], at = NOW): PlanUsage => ({ windows, at });

describe('merging reports', () => {
  it('keeps a window a sparse report left out, replaces one it carried, and returns new values', () => {
    const before = report([win('five_hour', 10, 120), win('seven_day', 3, 6000)]);
    const update = report([win('seven_day', 4, 5990)], NOW + 1000);
    const merged = mergePlanUsage(before, update);
    expect(merged.windows.map((w) => [w.id, w.usedPercent])).toEqual([['five_hour', 10], ['seven_day', 4]]);
    expect(merged.at).toBe(NOW + 1000);
    expect(before.windows[1]!.usedPercent).toBe(3);
  });

  it('keeps the last figure when a report names a window without one', () => {
    const merged = mergePlanUsage(report([win('five_hour', 42, 60)]), report([win('five_hour', null, null, { reached: true })]));
    expect(merged.windows[0]).toMatchObject({ usedPercent: 42, reached: true, resetsAt: NOW + 60 * 60_000 });
  });

  it('takes "no limits apply" whole', () => {
    expect(mergePlanUsage(report([win('five_hour', 42, 60)]), { windows: [], at: NOW, noLimits: true })).toEqual({ windows: [], at: NOW, noLimits: true });
  });
});

describe('what is shown', () => {
  it('is the same when only fractions of a percent, seconds of a reset or the as-of time differ', () => {
    expect(sameShown(report([win('five_hour', 41.6, 60)]), report([win('five_hour', 42.2, 60.4)], NOW + 5000))).toBe(true);
    expect(sameShown(report([win('five_hour', 41, 60)]), report([win('five_hour', 43, 60)]))).toBe(false);
    expect(sameShown(null, report([]))).toBe(false);
  });

  it('picks the tightest window that still holds, a used-up one first', () => {
    const u = report([win('five_hour', 30, 60), win('seven_day', 55, 6000), win('old', 99, -5)]);
    expect(tightestWindow(u, NOW)?.id).toBe('seven_day');
    expect(tightestWindow(report([win('five_hour', 30, 60), win('seven_day', null, 6000, { reached: true })]), NOW)?.id).toBe('seven_day');
    expect(tightestWindow(report([win('five_hour', null, 60)]), NOW)).toBeNull();
  });

  it('grades a window: warning from 80%, error when used up', () => {
    expect(levelOf(win('five_hour', 79, 60))).toBe('ok');
    expect(levelOf(win('five_hour', 80, 60))).toBe('near');
    expect(levelOf(win('five_hour', 100, 60))).toBe('full');
    expect(levelOf(win('five_hour', 20, 60, { reached: true }))).toBe('full');
  });

  it('words the reset the way people say it', () => {
    expect(resetText(NOW + 25 * 60_000, NOW)).toBe('resets in 25 min');
    expect(resetText(NOW + 200 * 60_000, NOW)).toBe('resets in 3 h 20 min');
    expect(resetText(NOW + 120 * 60_000, NOW)).toBe('resets in 2 h');
    expect(resetText(NOW + (4 * 24 + 6) * 3_600_000, NOW)).toBe('resets in 4 d 6 h');
    expect(resetText(NOW - 1, NOW)).toBe('reset since');
    expect(resetText(null, NOW)).toBe('');
  });

  it('gives the ring and the popup the same plan usage words', () => {
    const u = report([win('five_hour', 42.4, 200), win('seven_day', 12, 6000)]);
    expect(readout('claude', u, NOW)).toEqual({ label: 'Claude plan usage: 5-hour · 42% used · resets in 3 h 20 min', level: 'ok' });
    expect(windowText(u.windows[0]!, NOW)).toBe('5-hour · 42% used · resets in 3 h 20 min');
    expect(windowText(win('five_hour', 0.3, null), NOW)).toBe('5-hour · <1% used');
    expect(windowText(win('five_hour', 50, -1), NOW)).toBe('5-hour · reset since it was measured');
    expect(readout('codex', undefined, NOW)).toBeNull();
  });

  it('says plainly what an agent does not report, and where a session elsewhere has its figures', () => {
    expect(planNote('opencode', undefined, NOW)).toMatch(/OpenCode does not report plan limits/);
    expect(planNote('claude', undefined, NOW)).toMatch(/None reported since Kestrel started/);
    expect(planNote('claude', { windows: [], at: NOW, noLimits: true }, NOW)).toMatch(/no plan limits apply/);
    expect(planNote('codex', report([win('five_hour', 10, -1)]), NOW)).toMatch(/reset since/);
    expect(planNote('codex', report([win('five_hour', 10, 60)]), NOW)).toBeNull();
    expect(planNote('codex', report([win('five_hour', 10, 60)]), NOW, 'Mac mini')).toBe("Codex's plan usage is reported on Mac mini, where this session runs.");
  });
});

describe("a session's tokens and cost", () => {
  it('adds tokens turn by turn, and records a turn that reported tokens but no cost (Codex)', () => {
    const one = addTurnCost(null, undefined, { input: 19_523, output: 42 });
    expect(one).toEqual({ costUsd: 0, turns: 1, tokens: { input: 19_523, output: 42 } });
    expect(addTurnCost(one, 0.5, { input: 1, output: 2 })).toEqual({ costUsd: 0.5, turns: 2, tokens: { input: 19_524, output: 44 } });
    expect(addTurnCost(one, undefined, { input: 0, output: 0 })).toBe(one);
  });

  it('only counts real tokens', () => {
    expect(realTokens({ input: -1, output: 3 })).toBeUndefined();
    expect(realTokens({ input: Number.NaN, output: 3 })).toBeUndefined();
    expect(addTokens(null, undefined)).toBeNull();
  });

  it('says that Codex does not report cost rather than $0.00', () => {
    expect(spendText('codex', { costUsd: 0, turns: 1, tokens: { input: 19_523, output: 42 } })).toEqual({ cost: 'Codex does not report cost', tokens: '19.5k in · 42 out' });
    expect(spendText('claude', { costUsd: 0.25, turns: 1 })).toEqual({ cost: '$0.25', tokens: null });
    expect(spendText('opencode', null)).toEqual({ cost: 'Not recorded', tokens: null });
  });
});
