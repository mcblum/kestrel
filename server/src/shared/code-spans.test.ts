import { describe, expect, it } from 'vitest';
import { codeBlocks, codeLines, inlinePieces } from './code-spans.ts';

const joined = (text: string) => codeLines(text).map((l) => l.pieces.map((p) => p.text).join('') || l.text).join('\n');

describe('inline code', () => {
  it('finds code between single backticks and keeps the backticks in the text', () => {
    expect(inlinePieces('run `pnpm test` now')).toEqual([
      { kind: 'text', text: 'run ' },
      { kind: 'code', text: '`pnpm test`', ticks: 1 },
      { kind: 'text', text: ' now' },
    ]);
  });

  it('leaves a single stray backtick as plain text', () => {
    expect(inlinePieces("it's a `typo")).toEqual([{ kind: 'text', text: "it's a `typo" }]);
    expect(inlinePieces('`a` and `b')).toEqual([
      { kind: 'code', text: '`a`', ticks: 1 },
      { kind: 'text', text: ' and `b' },
    ]);
  });

  it('closes a run only with a run of the same length, so double backticks can hold one', () => {
    expect(inlinePieces('``a ` b`` c')).toEqual([
      { kind: 'code', text: '``a ` b``', ticks: 2 },
      { kind: 'text', text: ' c' },
    ]);
  });

  it('never spans lines', () => {
    expect(codeLines('a `b\nc` d').every((l) => l.pieces.every((p) => p.kind === 'text'))).toBe(true);
  });
});

describe('fenced blocks', () => {
  it('marks the opening, body and closing lines, and leaves the rest inline', () => {
    const lines = codeLines('before\n```ts\nconst a = `x`;\n```\nafter `y`');
    expect(lines.map((l) => l.fence ?? null)).toEqual([null, 'open', 'body', 'close', null]);
    expect(lines[2]!.pieces).toEqual([]); // backticks inside a fence are literal
    expect(lines[3]!.fenceEnd).toBe(true);
    expect(lines[4]!.pieces.some((p) => p.kind === 'code')).toBe(true);
  });

  it('runs a fence left open to the end', () => {
    const lines = codeLines('```\ncode\nmore `x`');
    expect(lines.map((l) => l.fence)).toEqual(['open', 'body', 'body']);
    expect(lines[2]!.fenceEnd).toBe(true);
  });

  it('closes only on a run at least as long as the opening one', () => {
    expect(codeLines('````\n```\n````').map((l) => l.fence)).toEqual(['open', 'body', 'close']);
  });

  it('does not open on a line with backticks after the language', () => {
    expect(codeLines('```js `x` ```')[0]!.fence).toBeUndefined();
  });

  it('always gives back the text as written', () => {
    for (const text of ['', '`', 'a\n\n```\n`b`\n```\n\n``c``', 'x ``` y', '```\n']) expect(joined(text)).toBe(text);
  });
});

describe('a sent message in blocks', () => {
  it('splits prose and fenced code, with the fence\'s language', () => {
    expect(codeBlocks('Try `this`:\n```bash\necho hi\n```\nThen')).toEqual([
      { kind: 'prose', lines: [[{ kind: 'text', text: 'Try ' }, { kind: 'code', text: '`this`', ticks: 1 }, { kind: 'text', text: ':' }]] },
      { kind: 'fence', lang: 'bash', code: 'echo hi' },
      { kind: 'prose', lines: [[{ kind: 'text', text: 'Then' }]] },
    ]);
  });

  it('keeps an unterminated fence as code to the end', () => {
    expect(codeBlocks('```\na\nb')).toEqual([{ kind: 'fence', lang: null, code: 'a\nb' }]);
  });
});
