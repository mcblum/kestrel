import { describe, expect, it } from 'vitest';
import { adfToMarkdown } from './jira-adf.ts';

type N = Record<string, unknown>;
const doc = (...content: N[]): N => ({ type: 'doc', version: 1, content });
const text = (value: string, ...marks: (string | N)[]): N => ({ type: 'text', text: value, ...(marks.length ? { marks: marks.map((m) => (typeof m === 'string' ? { type: m } : m)) } : {}) });
const p = (...content: N[]): N => ({ type: 'paragraph', content });
const node = (type: string, attrs: N | null, ...content: N[]): N => ({ type, ...(attrs ? { attrs } : {}), content });
const item = (...content: N[]): N => node('listItem', null, ...content);
const link = (href: string): N => ({ type: 'link', attrs: { href } });

describe('adfToMarkdown', () => {
  it('converts headings and marked text, keeping spaces outside the marks', () => {
    const md = adfToMarkdown(doc(node('heading', { level: 2 }, text('Summary')), p(text('A '), text('bold ', 'strong'), text('and'), text(' italic', 'em'), text(' word, '), text('gone', 'strike'), text(' and '), text('both', 'strong', 'em'), text('.'))));
    expect(md).toBe('## Summary\n\nA **bold** and *italic* word, ~~gone~~ and ***both***.');
  });

  it('converts inline code, links, and hard breaks', () => {
    const md = adfToMarkdown(doc(p(text('Run '), text('npm test', 'code'), text(' or `a`b`', 'code'), text(', see '), text('the guide', link('https://example.com/a (b)')), text(' and '), text('https://example.com', link('https://example.com')), { type: 'hardBreak' }, text('next line'))));
    expect(md).toBe('Run `npm test` `` or `a`b` ``, see [the guide](https://example.com/a%20%28b%29) and <https://example.com>  \nnext line');
  });

  it('converts a code block with its language', () => {
    expect(adfToMarkdown(doc(node('codeBlock', { language: 'ts' }, text('const a = 1;\nconst b = `x`;'))))).toBe('```ts\nconst a = 1;\nconst b = `x`;\n```');
    expect(adfToMarkdown(doc(node('codeBlock', null, text('```\ninner\n```'))))).toBe('````\n```\ninner\n```\n````');
  });

  it('converts bullet, numbered and task lists, nested', () => {
    const md = adfToMarkdown(
      doc(
        node('bulletList', null, item(p(text('Fruit')), node('bulletList', null, item(p(text('Apple'))), item(p(text('Pear'))))), item(p(text('Bread')), p(text('Second paragraph')))),
        node('orderedList', { order: 3 }, item(p(text('Third')), node('orderedList', null, item(p(text('Inner'))))), item(p(text('Fourth')))),
        node('taskList', null, node('taskItem', { state: 'DONE' }, text('Shipped')), node('taskItem', { state: 'TODO' }, text('Announce'))),
      ),
    );
    expect(md).toBe(['- Fruit', '  - Apple', '  - Pear', '- Bread', '', '  Second paragraph', '', '3. Third', '   1. Inner', '4. Fourth', '', '- [x] Shipped', '- [ ] Announce'].join('\n'));
  });

  it('converts a table, with and without a header row', () => {
    const cell = (type: string, ...content: N[]) => node(type, null, ...content);
    const row = (...cells: N[]) => node('tableRow', null, ...cells);
    const headed = node('table', null, row(cell('tableHeader', p(text('Name'))), cell('tableHeader', p(text('Count')))), row(cell('tableCell', p(text('a|b', 'code'))), cell('tableCell', p(text('one')), p(text('two')))));
    expect(adfToMarkdown(doc(headed))).toBe('| Name | Count |\n| --- | --- |\n| `a\\|b` | one two |');
    expect(adfToMarkdown(doc(node('table', null, row(cell('tableCell', p(text('a'))), cell('tableCell', p(text('b')))))))).toBe('|  |  |\n| --- | --- |\n| a | b |');
  });

  it('converts quotes, panels, expands and rules', () => {
    const md = adfToMarkdown(doc(node('blockquote', null, p(text('Said once')), p(text('and again'))), node('panel', { panelType: 'warning' }, p(text('Back up first.'))), { type: 'rule' }, node('expand', { title: 'Details' }, p(text('Inside')))));
    expect(md).toBe('> Said once\n>\n> and again\n\n> **Warning**\n>\n> Back up first.\n\n---\n\n**Details**\n\nInside');
  });

  it('converts mentions, emoji, cards, statuses, dates and attachments', () => {
    const md = adfToMarkdown(
      doc(
        p({ type: 'mention', attrs: { id: 'abc', text: '@Sam Example' } }, text(' shipped '), { type: 'emoji', attrs: { shortName: ':tada:', text: '🎉' } }, text(' '), { type: 'inlineCard', attrs: { url: 'https://example.com/pr/1' } }, text(' '), { type: 'status', attrs: { text: 'IN REVIEW' } }, text(' on '), { type: 'date', attrs: { timestamp: '1795392000000' } }),
        node('mediaSingle', null, { type: 'media', attrs: { type: 'file', id: 'x', alt: 'diagram.png' } }),
      ),
    );
    expect(md).toBe('@Sam Example shipped 🎉 <https://example.com/pr/1> `IN REVIEW` on 2026-11-23\n\n*(attachment: diagram.png)*');
  });

  it('passes Markdown typed into Jira through as it was written', () => {
    const md = adfToMarkdown(doc(p(text('## Plan')), p(text('- **one**'), { type: 'hardBreak' }, text('- two')), p(text('| a | b |')), p(text('| --- | --- |')), p(text('| 1 | 2 |'))));
    expect(md).toBe('## Plan  \n- **one**  \n- two\n\n| a | b |  \n| --- | --- |  \n| 1 | 2 |');
  });

  it('reads a plain document written in wiki markup as wiki markup', () => {
    const md = adfToMarkdown(doc(p(text('h2. Plan')), p(text('* Use the {{cache}}'), { type: 'hardBreak' }, text('* See [the guide|https://example.com]')), p(text('||Name||Count||')), p(text('|a|2|'))));
    expect(md).toBe('## Plan\n\n- Use the `cache`\n- See [the guide](https://example.com)\n\n| Name | Count |\n| --- | --- |\n| a | 2 |');
  });

  it('does not read a formatted document as wiki markup, whatever its text says', () => {
    expect(adfToMarkdown(doc(node('heading', { level: 1 }, text('Notes')), p(text('h2. is how a heading starts in {code} markup'))))).toBe('# Notes\n\nh2. is how a heading starts in {code} markup');
  });

  it('gives the text of what it does not know, and nothing for nothing', () => {
    expect(adfToMarkdown(doc(node('layoutSection', null, node('layoutColumn', null, p(text('Left'))), node('layoutColumn', null, p(text('Right')))), { type: 'mystery', text: 'x' } as N))).toBe('Left\n\nRight');
    expect(adfToMarkdown(null)).toBe('');
    expect(adfToMarkdown(doc())).toBe('');
    expect(adfToMarkdown('h3. Old answer\n* text')).toBe('### Old answer\n- text');
    expect(adfToMarkdown('Just words')).toBe('Just words');
  });
});
