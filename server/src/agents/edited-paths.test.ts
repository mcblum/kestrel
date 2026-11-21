import { describe, expect, it } from 'vitest';
import { pathsInside } from './edited-paths.ts';

describe('pathsInside', () => {
  it('makes paths relative to the working folder and drops the ones outside it', () => {
    expect(pathsInside('/w/tree', ['/w/tree/src/a.ts', 'b.md', '/elsewhere/c.ts', '/w/tree/src/a.ts', ''])).toEqual(['src/a.ts', 'b.md']);
    expect(pathsInside('/w/tree', ['/w/tree'])).toEqual([]);
  });
});
