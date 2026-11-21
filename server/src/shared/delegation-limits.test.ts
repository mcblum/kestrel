import { describe, expect, it } from 'vitest';
import { checkLimits, DEFAULT_LIMITS, LIMIT_RANGES, limitProblem, sanitizeLimits } from './delegation-limits.ts';

describe('delegation limits as a setting', () => {
  it('default to the numbers the design doc proposed, inside their ranges', () => {
    expect(DEFAULT_LIMITS).toEqual({ maxChildrenPerDelegate: 5, maxDepth: 2, maxLiveSessionsPerTree: 10 });
    expect(LIMIT_RANGES).toEqual({ maxChildrenPerDelegate: { min: 1, max: 10 }, maxDepth: { min: 1, max: 4 }, maxLiveSessionsPerTree: { min: 1, max: 30 } });
  });
  it('refuse a value outside its range, or not a whole number, with the range', () => {
    expect(limitProblem('maxDepth', 4)).toBeNull();
    expect(limitProblem('maxDepth', 5)).toBe('Levels a session tree may go down must be from 1 to 4; 5 is outside that.');
    expect(limitProblem('maxChildrenPerDelegate', 0)).toMatch(/from 1 to 10; 0 is outside/);
    expect(limitProblem('maxLiveSessionsPerTree', 2.5)).toMatch(/whole number from 1 to 30/);
    expect(limitProblem('maxLiveSessionsPerTree', '7')).toMatch(/whole number/);
  });
  it('check a sent value whole: every limit present and in range', () => {
    expect(checkLimits({ maxChildrenPerDelegate: 3, maxDepth: 1, maxLiveSessionsPerTree: 30 })).toEqual({ ok: true, limits: { maxChildrenPerDelegate: 3, maxDepth: 1, maxLiveSessionsPerTree: 30 } });
    expect(checkLimits({ maxChildrenPerDelegate: 3, maxDepth: 1 })).toMatchObject({ ok: false, reason: expect.stringMatching(/Sessions at work at once/) });
    expect(checkLimits(null)).toMatchObject({ ok: false });
  });
  it('make a stored value safe one limit at a time', () => {
    expect(sanitizeLimits(null)).toEqual(DEFAULT_LIMITS);
    expect(sanitizeLimits({})).toEqual(DEFAULT_LIMITS);
    expect(sanitizeLimits({ maxChildrenPerDelegate: 8, maxDepth: 99, maxLiveSessionsPerTree: 'x' })).toEqual({ ...DEFAULT_LIMITS, maxChildrenPerDelegate: 8 });
  });
});
