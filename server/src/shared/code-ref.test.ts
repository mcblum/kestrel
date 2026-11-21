import { describe, expect, test } from 'vitest';
import { codeAt, fenceStarts } from './code-ref.ts';

describe('the code block at a place in a message', () => {
  const text = 'Here:\n\n```swift\nlet a = 1\n\nlet b = 2\n```\n\nand then\n\n~~~\nplain\n~~~\n';

  test('reads a fenced block from where its fence starts: its language and its code, without the fence lines', () => {
    expect(codeAt(text, text.indexOf('```swift'))).toEqual({ lang: 'swift', code: 'let a = 1\n\nlet b = 2' });
    expect(codeAt(text, text.indexOf('~~~'))).toEqual({ lang: null, code: 'plain' });
  });

  test('a block inside a list item loses the indentation the list gave it', () => {
    const listed = '1. Run this:\n\n   ```bash\n   cd app\n     ls\n   ```\n2. Done';
    expect(codeAt(listed, listed.indexOf('```bash'))).toEqual({ lang: 'bash', code: 'cd app\n  ls' });
    const sameLine = '- ```js\n  const x = 1;\n  ```';
    expect(codeAt(sameLine, 2)).toEqual({ lang: 'js', code: 'const x = 1;' });
  });

  test('a longer fence holds shorter ones, and a block still being written runs to the end', () => {
    const nested = '````md\n```js\nx\n```\n````';
    expect(codeAt(nested, 0)).toEqual({ lang: 'md', code: '```js\nx\n```' });
    expect(codeAt('```py\nprint(1)\nprint(2)', 0)).toEqual({ lang: 'py', code: 'print(1)\nprint(2)' });
  });

  test('anywhere that is not the start of a fence is nothing', () => {
    expect(codeAt(text, 0)).toBeNull();
    expect(codeAt(text, text.indexOf('let a'))).toBeNull();
    expect(codeAt(text, 9_999)).toBeNull();
    expect(codeAt(text, -1)).toBeNull();
  });

  test('the fences of a sent message, in order, are where codeAt finds them', () => {
    const sent = 'one\n```swift\nlet a = 1\n```\ntwo\n  ```\nplain\n  ```';
    const starts = fenceStarts(sent);
    expect(starts).toEqual([sent.indexOf('```swift'), sent.lastIndexOf('```\nplain')]);
    expect(starts.map((at) => codeAt(sent, at))).toEqual([{ lang: 'swift', code: 'let a = 1' }, { lang: null, code: 'plain' }]);
  });
});
