import { describe, expect, it } from 'vitest';
import { diffEdit, mapOffset } from './draft-edit.ts';
import { backspace, paste, tab, type } from './draft-test-marks.ts';

describe('numbered lists renumber themselves as they are edited', () => {
  it('a line break in the middle of a list inserts an item and renumbers the rest', () => {
    expect(type('1. a|\n2. b\n3. c', '\n')).toBe('1. a\n2. |\n3. b\n4. c');
  });

  it('deleting an item renumbers the items after it', () => {
    expect(backspace('1. a\n[2. b\n]3. c')).toBe('1. a\n|2. c');
  });

  it('joining two lists by deleting the line between them makes one list', () => {
    expect(backspace('1. a\n\n|1. b\n2. c')).toBe('1. a\n|2. b\n3. c');
  });

  it('pasting lines into a list renumbers it', () => {
    expect(paste('1. a\n|\n2. b', '1. x\n1. y')).toBe('1. a\n2. x\n3. y|\n4. b');
  });

  it('a new "1. " line typed above a list starts the list there', () => {
    expect(type('|\n1. a\n2. b', '1. ')).toBe('1. |\n2. a\n3. b');
  });

  it('typed after an item, "5. " becomes the next number when the space makes it an item, not before', () => {
    expect(type('1. a\n|', '5')).toBe('1. a\n5|');
    expect(type('1. a\n|', '5.')).toBe('1. a\n5.|');
    expect(type('1. a\n|', '5. ')).toBe('1. a\n2. |');
  });

  it('keeps the caret where the user is typing when a number before it grows', () => {
    const nine = Array.from({ length: 9 }, (_, i) => `${i + 1}. x`).join('\n');
    expect(type(`${nine}|`, '\nnext')).toBe(`${nine}\n10. next|`);
    expect(type(`1. x|\n${nine.split('\n').slice(1).join('\n')}`, '\n')).toMatch(/^1\. x\n2\. \|\n3\. x/);
  });

  it('a restored list is not renumbered until it is edited, and then only the list edited', () => {
    expect(type('1. a\n1. b\n\nnote|', '!')).toBe('1. a\n1. b\n\nnote!|');
    expect(type('1. a\n1. b|', '!')).toBe('1. a\n2. b!|');
  });

  it('Tab nests an item and renumbers both lists', () => {
    expect(tab('1. a\n2. b|\n3. c')).toBe('1. a\n  1. b|\n2. c');
    expect(tab('1. a\n  1. b|\n2. c', true)).toBe('1. a\n2. b|\n3. c');
  });

  it('a task item continues as an unticked task, and ends on an empty one', () => {
    expect(type('- [x] done|', '\n')).toBe('- [x] done\n- [ ] |');
    expect(type('- [ ] a\n- [ ] |', '\n')).toBe('- [ ] a\n|');
  });
});

describe('the pieces', () => {
  it('maps an offset past replaced text, keeping one inside it inside', () => {
    expect(mapOffset(10, [{ start: 2, end: 4, inserted: 'abc' }])).toBe(11);
    expect(mapOffset(3, [{ start: 2, end: 4, inserted: '' }])).toBe(2);
    // Text inserted at the offset goes after it.
    expect(mapOffset(5, [{ start: 5, end: 5, inserted: 'xx' }])).toBe(5);
  });

  it('finds the edit the browser made, at the caret', () => {
    expect(diffEdit('aa', 'aaa', 2)).toEqual({ start: 2, end: 2, inserted: 'a' });
    expect(diffEdit('abc', 'ac', 1)).toEqual({ start: 1, end: 2, inserted: '' });
  });
});
