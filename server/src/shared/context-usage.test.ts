import { describe, expect, it } from 'vitest';
import { contextNote, percentLabel, shownRows, tokenCount, usedFraction, type ContextUsage } from './context-usage.ts';

const usage = (used: number, window: number, rows: ContextUsage['rows'] = []): ContextUsage => ({ model: 'm', usedTokens: used, windowTokens: window, rows, at: 0 });

describe('context usage', () => {
  it('gives the share in use, clamped', () => {
    expect(usedFraction(usage(50_000, 200_000))).toBe(0.25);
    expect(usedFraction(usage(300_000, 200_000))).toBe(1);
    expect(usedFraction(usage(10, 0))).toBe(0);
  });

  it('labels the percentage, with <1% for a little', () => {
    expect(percentLabel(usage(15_538, 1_000_000))).toBe('2%');
    expect(percentLabel(usage(1_000, 1_000_000))).toBe('<1%');
    expect(percentLabel(usage(0, 1_000_000))).toBe('0%');
  });

  it('says token counts the short way', () => {
    expect([tokenCount(950), tokenCount(15_538), tokenCount(200_000), tokenCount(1_000_000), tokenCount(1_250_000)]).toEqual(['950', '15.5k', '200k', '1M', '1.3M']);
  });

  it('drops empty rows and puts deferred ones apart', () => {
    const shown = shownRows(usage(1, 2, [
      { name: 'Messages', tokens: 5, kind: 'used' },
      { name: 'Empty', tokens: 0, kind: 'used' },
      { name: 'Deferred tools', tokens: 9, kind: 'deferred' },
      { name: 'Free space', tokens: 3, kind: 'free' },
    ]));
    expect(shown.inWindow.map((r) => r.name)).toEqual(['Messages', 'Free space']);
    expect(shown.deferred.map((r) => r.name)).toEqual(['Deferred tools']);
  });

  it('says why there is no measurement, the same words on every device', () => {
    const at = { reports: true, agentLabel: 'Codex', started: true, working: false };
    expect(contextNote({ ...at, reports: false })).toBe('Codex does not say how full its context window is.');
    expect(contextNote({ ...at, started: false })).toBe('Measured once the conversation has started.');
    expect(contextNote({ ...at, working: true })).toBe('Measured when this turn ends.');
    expect(contextNote(at)).toBe('Not measured yet. It is measured each time a turn ends.');
  });
});
