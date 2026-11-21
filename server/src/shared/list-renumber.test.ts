import { describe, expect, it } from 'vitest';
import { applyEdits } from './draft-edit.ts';
import { nestItems, orderedRuns, renumberEdits } from './list-renumber.ts';

const markers = (text: string) => orderedRuns(text).map((run) => run.map((item) => item.marker));
/** The text with every run renumbered. */
const renumbered = (text: string) => applyEdits(text, renumberEdits(text, 0, text.length));

describe('runs of numbered items', () => {
  it('a run is consecutive numbered items at the same nesting', () => {
    expect(markers('1. a\n2. b\n3. c')).toEqual([['1.', '2.', '3.']]);
    expect(markers('1. a\n\n1. b')).toEqual([['1.'], ['1.']]);
    expect(markers('1. a\ntext\n1. b')).toEqual([['1.'], ['1.']]);
  });

  it('a nested run is its own run and does not break the outer run that continues after it', () => {
    expect(markers('1. a\n   1. x\n   2. y\n2. b')).toEqual([['1.', '2.'], ['1.', '2.']]);
    expect(markers('1. a\n  - x\n2. b')).toEqual([['1.', '2.']]);
    expect(markers('1. a\n   more of a\n2. b')).toEqual([['1.', '2.']]);
  });

  it('a bullet at the same nesting, a fence or code ends a run; lines in code are never items', () => {
    expect(markers('1. a\n- b\n2. c')).toEqual([['1.'], ['2.']]);
    expect(markers('1. a\n```\n2. code\n```\n3. c')).toEqual([['1.'], ['3.']]);
  });
});

describe('renumbering', () => {
  it('counts up by one from the first item, keeping its punctuation', () => {
    expect(renumbered('1. a\n5. b\n2. c')).toBe('1. a\n2. b\n3. c');
    expect(renumbered('3. a\n3. b\n3. c')).toBe('3. a\n4. b\n5. c');
    expect(renumbered('1) a\n2. b')).toBe('1) a\n2) b');
  });

  it('renumbers nested runs on their own and leaves bullets and code alone', () => {
    expect(renumbered('1. a\n   4. x\n   4. y\n7. b\n- z\n```\n9. q\n```')).toBe('1. a\n   4. x\n   5. y\n2. b\n- z\n```\n9. q\n```');
  });

  it('grows a number to two digits', () => {
    const nine = Array.from({ length: 10 }, (_, i) => `${i < 9 ? i + 1 : 1}. x`).join('\n');
    expect(renumbered(nine).split('\n').at(-1)).toBe('10. x');
  });

  it('only touches runs on or next to the edited lines', () => {
    const text = '1. a\n1. b\n\nmiddle\n\n1. c\n1. d';
    const at = text.indexOf('1. c');
    expect(applyEdits(text, renumberEdits(text, at, at))).toBe('1. a\n1. b\n\nmiddle\n\n1. c\n2. d');
  });
});

describe('Tab on list items', () => {
  const tab = (marked: string, outdent = false) => {
    const start = marked.indexOf('[');
    const end = marked.indexOf(']') - 1;
    const text = marked.replace('[', '').replace(']', '');
    const nest = nestItems(text, start, end, outdent);
    if (!nest) return null;
    const next = applyEdits(text, [nest.edit]);
    return `${next.slice(0, nest.start)}[${next.slice(nest.start, nest.end)}]${next.slice(nest.end)}`;
  };

  it('moves an item in by two spaces, the caret with its text', () => {
    expect(tab('- a\n- b[]')).toBe('- a\n  - b[]');
    expect(tab('- a\n- [b]')).toBe('- a\n  - [b]');
  });

  it('a numbered item nested under the item above starts its own list at 1', () => {
    expect(tab('1. a\n2. b[]')).toBe('1. a\n  1. b[]');
  });

  it('moves every item of a selection, and Shift Tab moves them back', () => {
    expect(tab('[- a\n- b]')).toBe('  [- a\n  - b]');
    expect(tab('  - a\n  - [b]', true)).toBe('  - a\n- [b]');
    expect(tab('- [a]', true)).toBe('- [a]');
  });

  it('does nothing outside a list', () => {
    expect(tab('plain[]')).toBeNull();
    expect(tab('```\n- in code[]\n```')).toBeNull();
  });
});
