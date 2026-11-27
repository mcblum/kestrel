import { describe, expect, it } from 'vitest';
import { AS_OF_REFRESH_MS, PlanUsageStore } from './plan-usage.ts';
import type { PlanUsage } from './shared/plan-usage.ts';

const AT = Date.UTC(2026, 10, 27, 12, 0);
const at = (percent: number, when = AT): PlanUsage => ({ windows: [{ id: 'five_hour', label: '5-hour', usedPercent: percent, resetsAt: AT + 3_600_000, order: 0 }], at: when });

describe('the one copy per agent, pushed only on change', () => {
  it('pushes the first report, not a burst that draws the same, and again when a figure moves', () => {
    const store = new PlanUsageStore();
    const pushes: unknown[] = [];
    store.onChange((view) => pushes.push(view));
    expect(store.note('claude', at(41.6))).toBe(true);
    for (let i = 0; i < 50; i += 1) store.note('claude', at(41.6 + i * 0.01, AT + i * 1000));
    expect(pushes).toHaveLength(1);
    expect(store.note('claude', at(43, AT + 60_000))).toBe(true);
    expect(pushes).toHaveLength(2);
    expect(store.view().claude?.windows[0]?.usedPercent).toBe(43);
  });

  it('keeps each agent apart, and an agent that did not change keeps its identity', () => {
    const store = new PlanUsageStore();
    store.note('claude', at(10));
    const claude = store.view().claude;
    store.note('codex', at(20));
    expect(store.view().claude).toBe(claude);
    expect(store.view().codex?.windows[0]?.usedPercent).toBe(20);
  });

  it('moves the as-of time once an unchanged report is well newer than the pushed one', () => {
    const store = new PlanUsageStore();
    store.note('codex', at(5));
    expect(store.note('codex', at(5, AT + AS_OF_REFRESH_MS - 1))).toBe(false);
    expect(store.note('codex', at(5, AT + AS_OF_REFRESH_MS))).toBe(true);
    expect(store.view().codex?.at).toBe(AT + AS_OF_REFRESH_MS);
  });

  it('stops telling a listener that left', () => {
    const store = new PlanUsageStore();
    let told = 0;
    const off = store.onChange(() => (told += 1));
    store.note('claude', at(1));
    off();
    store.note('claude', at(50));
    expect(told).toBe(1);
  });
});
