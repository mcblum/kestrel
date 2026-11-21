import { describe, expect, it } from 'vitest';
import { clockTime, dayLabel, daysBetween, finishedText, shortTime, whenText } from './when.ts';

// Local times, so the calendar day is the viewer's whatever zone the tests run in.
const at = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 11, 15, 0, 10);

describe('calendar days, not elapsed hours', () => {
  it('calls 23:50 yesterday "yesterday" when seen at 00:10 today, though only 20 minutes passed', () => {
    const then = at(2026, 11, 14, 23, 50);
    expect(daysBetween(then, NOW)).toBe(1);
    expect(dayLabel(then, NOW)).toBe('Yesterday');
    expect(whenText(then, NOW)).toBe(`yesterday ${clockTime(then)}`);
  });

  it('calls 20 hours ago "today" when it is the same calendar day, and "yesterday" when it is not', () => {
    const evening = at(2026, 11, 15, 22, 0);
    const sameDay = at(2026, 11, 15, 2, 0);
    expect(dayLabel(sameDay, evening)).toBe('Today');
    expect(whenText(sameDay, evening)).toBe(`today ${clockTime(sameDay)}`);
    const morning = at(2026, 11, 15, 10, 0);
    const dayBefore = at(2026, 11, 14, 14, 0);
    expect(dayLabel(dayBefore, morning)).toBe('Yesterday');
  });

  it('gives a date for anything older, with the year only when it differs', () => {
    expect(dayLabel(at(2026, 11, 12, 9, 0), NOW)).not.toMatch(/Today|Yesterday|2026/);
    expect(dayLabel(at(2025, 11, 12, 9, 0), NOW)).toMatch(/2025/);
  });

  it('agrees for the divider and the Details rows at the same instant', () => {
    const then = at(2026, 11, 15, 0, 5);
    expect(dayLabel(then, NOW).toLowerCase()).toBe(whenText(then, NOW).split(' ')[0]);
  });
});

describe('when a turn finished', () => {
  it('is the time alone the same day, and the date and time on an earlier day', () => {
    const today = at(2026, 11, 15, 0, 5);
    expect(finishedText(today, NOW)).toBe(shortTime(today));
    const before = at(2026, 11, 14, 15, 42);
    const date = new Date(before).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    expect(finishedText(before, NOW)).toBe(`${date}, ${shortTime(before)}`);
  });
});
