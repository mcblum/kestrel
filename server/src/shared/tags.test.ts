import { describe, expect, it } from 'vitest';
import { TAG_MAX, addTag, hasTag, parseTag, removeTag, tagCounts } from './tags.ts';

describe('parseTag', () => {
  it('trims, collapses inner whitespace and keeps the case typed', () => {
    expect(parseTag('  PLAT-1234 ')).toEqual({ tag: 'PLAT-1234' });
    expect(parseTag('release \t  train\n')).toEqual({ tag: 'release train' });
  });
  it('refuses empty, too long and non-text tags with a reason', () => {
    expect(parseTag('   ')).toEqual({ reason: 'Write the tag first.' });
    expect(parseTag('x'.repeat(TAG_MAX))).toEqual({ tag: 'x'.repeat(TAG_MAX) });
    expect(parseTag('x'.repeat(TAG_MAX + 1))).toEqual({ reason: `A tag is at most ${TAG_MAX} characters.` });
    expect(parseTag(42)).toEqual({ reason: 'A tag must be text.' });
  });
});

describe('a session’s tags', () => {
  it('compare without regard to case and keep the case first typed, with no duplicates', () => {
    const one = addTag([], 'PLAT-1234');
    expect(one).toEqual(['PLAT-1234']);
    expect(addTag(one, 'plat-1234')).toBe(one);
    expect(hasTag(one, 'Plat-1234')).toBe(true);
    expect(addTag(one, 'infra')).toEqual(['PLAT-1234', 'infra']);
  });
  it('are removed in any case, and stay the same array when the tag is not there', () => {
    const tags = ['PLAT-1234', 'infra'];
    expect(removeTag(tags, 'plat-1234')).toEqual(['infra']);
    expect(removeTag(tags, 'other')).toBe(tags);
  });
});

describe('tagCounts', () => {
  it('counts each tag once per session, in the case of the earliest session, alphabetically', () => {
    const counts = tagCounts([{ tags: ['PLAT-10', 'infra'] }, { tags: ['plat-10'] }, { tags: ['PLAT-9', 'Alpha'] }, { tags: [] }]);
    expect(counts).toEqual([
      { tag: 'Alpha', count: 1 },
      { tag: 'infra', count: 1 },
      { tag: 'PLAT-9', count: 1 },
      { tag: 'PLAT-10', count: 2 },
    ]);
  });
});
