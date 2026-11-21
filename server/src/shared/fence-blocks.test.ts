import { describe, expect, it } from 'vitest';
import { boxLines, fenceBlocks, fenceLanguage, visibleOffset, wholeSelection } from './fence-blocks.ts';
import { arrow, backspace, paste, type } from './draft-test-marks.ts';

const kinds = (text: string) => boxLines(text).map((l) => l.kind);

describe('what the box shows of a code block', () => {
  it('a closed block with code shows only its code, its fence lines hidden but still in the text', () => {
    expect(kinds('a\n```ts\nconst x = 1;\n```\nb')).toEqual(['text', 'hidden', 'code', 'hidden', 'text']);
    const code = boxLines('```ts\none\ntwo\n```').filter((l) => l.kind === 'code');
    expect(code.map((l) => [l.first ?? false, l.last ?? false])).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(code[0]!.lang).toBe('ts');
  });

  it('a fence left open and a block with no code show their fence lines, with no label', () => {
    expect(kinds('```py\nprint(1)')).toEqual(['fence', 'code']);
    expect(boxLines('```py\nprint(1)')[0]!.lang).toBeNull();
    expect(kinds('```\n```')).toEqual(['fence', 'fence']);
  });

  it('reads the language as a name, lower case, or none', () => {
    expect(fenceLanguage('```TypeScript')).toBe('typescript');
    expect(fenceLanguage('``` c++')).toBe('c++');
    expect(fenceLanguage('```')).toBeNull();
    expect(fenceLanguage('```{weird}')).toBeNull();
  });

  it('keeps a fence line in view while the caret is on it (``` being typed above another block)', () => {
    const text = '```\n```js\nx\n```';
    expect(kinds(text)[0]).toBe('hidden');
    expect(boxLines(text, 3).map((l) => l.kind)).toEqual(['fence', 'code', 'code', 'fence']);
  });

  it('Select All, which the browser stops at the code of a block at either end, is the whole draft', () => {
    const text = '```\ncode\n```';
    expect(wholeSelection(text, 4, 8)).toEqual({ start: 0, end: text.length });
    expect(wholeSelection(text, 5, 8)).toEqual({ start: 5, end: 8 });
    expect(wholeSelection('a\n```\ncode\n```', 6, 10)).toEqual({ start: 6, end: 10 });
  });

  it('keeps the caret off hidden fence lines: into the code at its start or its end', () => {
    const text = 'a\n```\ncode\n```\nb';
    const [block] = fenceBlocks(text);
    expect(visibleOffset(text, block!.openStart)).toBe(block!.bodyStart);
    expect(visibleOffset(text, block!.openEnd)).toBe(block!.bodyStart);
    expect(visibleOffset(text, block!.closeStart!)).toBe(block!.bodyEnd);
    expect(visibleOffset(text, text.length)).toBe(text.length);
    expect(visibleOffset('```\ncode\n```', 12)).toBe(8);
  });
});

describe('making a code block', () => {
  it('the third backtick makes the block at once: closing fence in, the caret on the empty line inside', () => {
    expect(type('|', '```')).toBe('```\n|\n```');
    expect(type('intro\n|', '```')).toBe('intro\n```\n|\n```');
    expect(type('|\nafter', '```')).toBe('```\n|\n```\nafter');
    // The three arriving as one insertion make it too.
    expect(paste('|', '```')).toBe('```\n|\n```');
    // Text pasted or typed next lands in the code, never on the fence line.
    expect(paste(type('|', '```'), 'const a = 1;\nconst b = 2;')).toBe('```\nconst a = 1;\nconst b = 2;|\n```');
  });

  it('a language typed first and then a line break names the block, and the line is empty again', () => {
    expect(type('|', '```ts\n')).toBe('```ts\n|\n```');
    expect(type('|', '```python\n')).toBe('```python\n|\n```');
    // Not a language: it is the first line of code, and the line break is an ordinary one.
    expect(type('|', '```hello\n')).toBe('```\nhello\n|\n```');
    // A block that already has a language, or more than one line, is not renamed.
    expect(type('```js\nts|\n```', '\n')).toBe('```js\nts\n|\n```');
  });

  it('three backticks typed inside a block close it there, and make no new block', () => {
    expect(type('```\none\n|\ntwo\n```', '```')).not.toContain('```\n\n```');
  });

  it('``` and a line break makes an empty block with its closing fence, the caret inside', () => {
    expect(type('|', '```\n')).toBe('```\n|\n```');
    expect(type('intro\n|', '```js\n')).toBe('intro\n```js\n|\n```');
  });

  it('works above existing text, which stays outside the block', () => {
    expect(type('|\nafter', '```\n')).toBe('```\n|\n```\nafter');
  });

  it('typed above another block, the two stay separate blocks', () => {
    expect(type('|\n```js\nx\n```', '```\n')).toBe('```\n|\n```\n```js\nx\n```');
    expect(type('|\n```\nx\n```', '```\n')).toBe('```\n|\n```\n```\nx\n```');
  });

  it('a line break inside code is a line of code, list markers included', () => {
    expect(type('```\n1. a|\n```', '\n')).toBe('```\n1. a\n|\n```');
  });
});

describe('leaving and removing a block', () => {
  it('a line break on an empty last line of code leaves the block on a new line after it', () => {
    expect(type('```\ncode|\n```', '\n\n')).toBe('```\ncode\n```\n|');
    expect(type('```\ncode|\n```\nnext', '\n\n')).toBe('```\ncode\n```\n|\nnext');
  });

  it('a line break in a block with nothing in it leaves the block as it is; Backspace removes it', () => {
    expect(type('a\n```\n|\n```\nb', '\n')).toBe('a\n```\n|\n```\nb');
    expect(backspace('a\n```\n|\n```\nb')).toBe('a|\nb');
  });

  it('Arrow Down on the last line of a block that ends the draft makes a line after it', () => {
    expect(arrow('```\nco|de\n```', true)).toBe('```\ncode\n```\n|');
    expect(arrow('```\ncode|\n```\nafter', true)).toBeNull();
    expect(arrow('```\none|\ntwo\n```', true)).toBeNull();
  });

  it('Arrow Up on the first line of a block that starts the draft makes a line before it', () => {
    expect(arrow('```\nco|de\n```', false)).toBe('|\n```\ncode\n```');
  });

  it('Backspace at the start of an empty block removes it', () => {
    expect(backspace('a\n```\n|\n```\nb')).toBe('a|\nb');
    expect(backspace('```\n|\n```')).toBe('|');
  });

  it('Backspace at the start of a block with code unwraps it: the fences go, the code stays as text', () => {
    expect(backspace('a\n```ts\n|one\ntwo\n```\nb')).toBe('a\n|one\ntwo\nb');
  });

  it('Backspace at the start of the line after a block removes an empty line, or only moves into the code', () => {
    expect(backspace('```\ncode\n```\n|')).toBe('```\ncode|\n```');
    expect(backspace('```\ncode\n```\n|\nmore')).toBe('```\ncode|\n```\nmore');
    expect(backspace('```\ncode\n```\n|text')).toBe('```\ncode|\n```\ntext');
  });

  it('Delete at the end of the code or of the line before a block never joins a fence line', () => {
    expect(backspace('```\ncode|\n```\ntext', true)).toBe('```\ncode|\n```\ntext');
    expect(backspace('```\ncode|\n```\n\ntext', true)).toBe('```\ncode|\n```\ntext');
    expect(backspace('text|\n```\ncode\n```', true)).toBe('text|\n```\ncode\n```');
  });
});

describe('fences stay in pairs', () => {
  it('deleting from inside the code past the block closes it where the edit ended', () => {
    expect(backspace('```\none\nt[wo\n```\naf]ter')).toBe('```\none\nt|ter\n```');
  });

  it('deleting from before a block into its code takes its closing fence too', () => {
    expect(backspace('be[fore\n```\none\ntw]o\n```\nafter')).toBe('be|o\nafter');
  });

  it('deleting a whole block and more leaves no fence', () => {
    expect(backspace('[a\n```\none\n```\nb]')).toBe('|');
  });

  it('pasted text with an unclosed fence is closed after it', () => {
    expect(paste('|', '```js\nlet a')).toBe('```js\nlet a|\n```');
  });

  it('pasted text with whole blocks makes blocks', () => {
    expect(boxLines(paste('|', 'see\n```\nx\n```').replace('|', '')).map((l) => l.kind)).toEqual(['text', 'hidden', 'code', 'hidden']);
  });

  it('a draft restored with an open fence gets its closing fence at the end when next edited', () => {
    expect(type('note|\n```py\nprint(1)', '!')).toBe('note!|\n```py\nprint(1)\n```');
  });

  it('nothing is repaired while the first two backticks are typed', () => {
    expect(type('|\ntext', '``')).toBe('``|\ntext');
  });

  it('removing the code of a block with a selection inside it keeps the block', () => {
    expect(backspace('```\n[one\ntwo]\n```')).toBe('```\n|\n```');
  });
});
