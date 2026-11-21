import { describe, expect, it } from 'vitest';
import { diffCounts } from './diff-counts.ts';

describe('lines added and removed', () => {
  it('counts changed lines across diffs and leaves the file headers out', () => {
    const diff = ['--- a/x.ts', '+++ b/x.ts', '@@ -1,3 +1,4 @@', ' same', '-old', '+new', '+more'].join('\n');
    expect(diffCounts([diff])).toEqual({ added: 2, removed: 1 });
    expect(diffCounts([diff, diff])).toEqual({ added: 4, removed: 2 });
    expect(diffCounts([])).toEqual({ added: 0, removed: 0 });
  });
});
