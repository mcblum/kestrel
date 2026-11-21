import { describe, expect, it } from 'vitest';
import { breakInList, listMarker, markerWidthEm, MAX_LIST_INDENT } from './list-lines.ts';

describe('list items in a draft', () => {
  it('a bullet and a space starts an unordered item', () => {
    for (const bullet of ['-', '*', '+']) expect(listMarker(`${bullet} milk`)).toEqual({ length: 2, indent: 0, marker: bullet, ordered: false });
    // As soon as the space is typed, before any text.
    expect(listMarker('- ')).toMatchObject({ length: 2, ordered: false });
  });
  it('a number with a dot or a bracket and a space starts an ordered item', () => {
    expect(listMarker('1. first')).toEqual({ length: 3, indent: 0, marker: '1.', ordered: true });
    expect(listMarker('12) twelfth')).toEqual({ length: 4, indent: 0, marker: '12)', ordered: true });
  });
  it('leading spaces nest it, and every space before the text belongs to the marker', () => {
    expect(listMarker('  - nested')).toEqual({ length: 4, indent: 2, marker: '-', ordered: false });
    expect(listMarker('-   wide gap')).toMatchObject({ length: 4 });
    expect(listMarker(`${' '.repeat(40)}- deep`)!.indent).toBe(MAX_LIST_INDENT);
  });
  it('is not an item without the space, or when the marker is not at the start', () => {
    for (const line of ['-milk', '1.first', 'a - b', '--- rule', '1.5 litres', '', 'text', '2024 was long', '\t- tab']) expect(listMarker(line)).toBeNull();
  });
  it('gives a number more room the more digits it has, and nesting more again', () => {
    const width = (line: string) => markerWidthEm(listMarker(line)!);
    expect(width('10. x')).toBeGreaterThan(width('9. x'));
    expect(width('  - x')).toBeGreaterThan(width('- x'));
    expect(width('- x')).toBe(1.15);
  });
});

describe('a line break typed in a list item', () => {
  /** The text after a line break at `|`, with the caret shown as `|` again. */
  const after = (marked: string) => {
    const caret = marked.indexOf('|');
    const text = marked.replace('|', '');
    const edit = breakInList(text, caret);
    if (!edit) return null;
    const next = text.slice(0, edit.start) + edit.inserted + text.slice(edit.end);
    const at = edit.start + edit.inserted.length;
    return `${next.slice(0, at)}|${next.slice(at)}`;
  };

  it('starts the next numbered item, counting on with the same punctuation', () => {
    expect(after('1. first|')).toBe('1. first\n2. |');
    expect(after('9) nine|')).toBe('9) nine\n10) |');
    expect(after('intro\n3. third|\nafter')).toBe('intro\n3. third\n4. |\nafter');
  });

  it('starts the next bullet with the same bullet and the same nesting', () => {
    expect(after('- milk|')).toBe('- milk\n- |');
    expect(after('  * nested|')).toBe('  * nested\n  * |');
    expect(after('    2. deep|')).toBe('    2. deep\n    3. |');
  });

  it('in the middle of an item, the rest of it becomes the next item', () => {
    expect(after('1. first| second')).toBe('1. first\n2. | second');
  });

  it('on an item with nothing in it, ends the list: the marker goes and the line is left empty', () => {
    expect(after('1. first\n2. |')).toBe('1. first\n|');
    expect(after('- |')).toBe('|');
    expect(after('  -   |\nnext')).toBe('|\nnext');
  });

  it('is an ordinary line break anywhere else', () => {
    for (const marked of ['plain text|', '|1. before the marker', '1|. inside the marker', '1.first|', '```\n1. in code|\n```', '']) expect(after(marked.includes('|') ? marked : `${marked}|`)).toBeNull();
  });

  it('counts on from a number at the limit without growing the marker past what a list line is', () => {
    expect(after('9999. last|')).toBeNull();
  });
});

