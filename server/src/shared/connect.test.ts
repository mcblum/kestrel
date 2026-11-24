import { describe, expect, it } from 'vitest';
import { keptOffWith } from './connect.ts';

describe('keptOffWith', () => {
  it('adds a project once and removes it, leaving the others as they were', () => {
    expect(keptOffWith([], 'p1', true)).toEqual(['p1']);
    expect(keptOffWith(['p1'], 'p1', true)).toEqual(['p1']);
    expect(keptOffWith(['p1', 'p2'], 'p1', false)).toEqual(['p2']);
    expect(keptOffWith(['p2'], 'p1', false)).toEqual(['p2']);
  });
});
