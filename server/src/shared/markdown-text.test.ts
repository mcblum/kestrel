import { describe, expect, it } from 'vitest';
import { markdownToText } from './markdown-text.ts';

describe('markdown as plain text', () => {
  it('drops heading marks, emphasis and strikethrough', () => {
    expect(markdownToText('## The plan\n\nThis is **bold**, *soft*, _also_, __strong__ and ~~gone~~.')).toBe('The plan\n\nThis is bold, soft, also, strong and gone.');
  });

  it('reduces links and pictures to their text', () => {
    expect(markdownToText('See [the docs](https://x.dev/a) and ![a chart](c.png), or <https://x.dev>.')).toBe('See the docs and a chart, or https://x.dev.');
  });

  it('keeps code as it is, without fences or backticks', () => {
    expect(markdownToText('Run `pnpm test` first.\n\n```bash\necho **not bold** [x](y)\n```\n\nThen go.')).toBe('Run pnpm test first.\n\necho **not bold** [x](y)\n\nThen go.');
  });

  it('keeps a fence left open to the end as code', () => {
    expect(markdownToText('Look:\n```\n# not a heading')).toBe('Look:\n# not a heading');
  });

  it('turns list items into plain lines; numbered ones keep their number', () => {
    expect(markdownToText('- one\n* two\n  + nested\n- [x] done\n1. first\n2. second')).toBe('one\ntwo\n  nested\ndone\n1. first\n2. second');
  });

  it('drops quote marks and rules, and keeps snake_case and 2*3*4 as written', () => {
    expect(markdownToText('> quoted *text*\n\n---\n\nuse my_var_name and 2*3*4')).toBe('quoted text\n\nuse my_var_name and 2*3*4');
  });

  it('writes a table as tab-separated lines without the divider', () => {
    expect(markdownToText('| Name | Size |\n| --- | ---: |\n| **a** | 1 |')).toBe('Name\tSize\na\t1');
  });

  it('unescapes escaped characters', () => {
    expect(markdownToText('a \\*literal\\* star')).toBe('a *literal* star');
  });
});
