import { describe, expect, it } from 'vitest';
import { looksLikeWiki, wikiInline, wikiToMarkdown } from './jira-wiki.ts';

describe('looksLikeWiki', () => {
  it('knows wiki markup by the marks only it has', () => {
    expect(looksLikeWiki('h2. Summary\nText')).toBe(true);
    expect(looksLikeWiki('Run it:\n{code:bash}\nmake\n{code}')).toBe(true);
    expect(looksLikeWiki('||Name||Value||\n|a|b|')).toBe(true);
    expect(looksLikeWiki('See [the guide|https://example.com/guide].')).toBe(true);
  });

  it('leaves Markdown and plain words alone', () => {
    expect(looksLikeWiki('## Summary\n\n- one\n- **two**\n\n| a | b |\n| --- | --- |')).toBe(false);
    expect(looksLikeWiki('Uses ${{ secrets.TOKEN }} in the workflow, see [docs](https://example.com).')).toBe(false);
    expect(looksLikeWiki('The cache is slow. Fix it.')).toBe(false);
  });
});

describe('wikiInline', () => {
  it('converts bold, strike, citation and monospace, and keeps italic', () => {
    expect(wikiInline('A *bold* and _italic_ word, -gone- and ??cited??, with {{npm run build}}.')).toBe('A **bold** and _italic_ word, ~~gone~~ and *cited*, with `npm run build`.');
  });

  it('touches nothing inside monospace, and leaves hyphens and stars in ordinary text', () => {
    expect(wikiInline('{{a *b* -c-}} stays')).toBe('`a *b* -c-` stays');
    expect(wikiInline('a well-known 2 * 3 * 4 - and - so on')).toBe('a well-known 2 * 3 * 4 - and - so on');
  });

  it('converts links, bare links, mentions, pictures, colour and forced breaks', () => {
    expect(wikiInline('See [the guide|https://example.com/guide] or [https://example.com].')).toBe('See [the guide](https://example.com/guide) or <https://example.com>.');
    expect(wikiInline('Ask [~sam.example] about !diagram.png|thumbnail! and !https://example.com/a.png!')).toBe('Ask @sam.example about *(attachment: diagram.png)* and ![](https://example.com/a.png)');
    expect(wikiInline('{color:red}Careful{color} here\\\\next')).toBe('Careful here  \nnext');
    expect(wikiInline('Wow!really! fine')).toBe('Wow!really! fine');
  });
});

describe('wikiToMarkdown', () => {
  it('converts headings, rules and quotes', () => {
    expect(wikiToMarkdown('h1. Title\nh3. Part *one*\n----\nbq. Said once')).toBe('# Title\n### Part **one**\n---\n> Said once');
  });

  it('converts bullet and numbered lists, nested', () => {
    const wiki = ['* Fruit', '** Apple', '** Pear', '* Bread', '# First', '## Inner', '#* Mixed', '# Second', '- Dash'].join('\n');
    expect(wikiToMarkdown(wiki)).toBe(['- Fruit', '  - Apple', '  - Pear', '- Bread', '1. First', '   1. Inner', '   - Mixed', '1. Second', '- Dash'].join('\n'));
  });

  it('converts code blocks with a language and a title, and noformat', () => {
    const wiki = ['Run:', '{code:title=build.sh|language=bash}', 'make *all*', '', 'h2. not a heading', '{code}', '{code:ts}const a = 1;{code}', '{noformat}', 'raw {{text}}', '{noformat}'].join('\n');
    expect(wikiToMarkdown(wiki)).toBe(['Run:', '', '**build.sh**', '', '```bash', 'make *all*', '', 'h2. not a heading', '```', '', '```ts', 'const a = 1;', '```', '', '```', 'raw {{text}}', '```'].join('\n'));
  });

  it('converts tables, with and without a header row', () => {
    expect(wikiToMarkdown('||Name||Count||\n|*Cache*|2|\n|Queue|{{n}}|')).toBe('| Name | Count |\n| --- | --- |\n| **Cache** | 2 |\n| Queue | `n` |');
    expect(wikiToMarkdown('|a|b|\n|c|d|')).toBe('|  |  |\n| --- | --- |\n| a | b |\n| c | d |');
  });

  it('converts quote blocks and panels to quotes', () => {
    expect(wikiToMarkdown('Before\n{quote}\nFirst line\nSecond line\n{quote}\nAfter')).toBe('Before\n\n> First line  \n> Second line\n\nAfter');
    expect(wikiToMarkdown('{panel:title=Rollout}\n* Staged\n{panel}')).toBe('> **Rollout**\n>\n> - Staged');
    expect(wikiToMarkdown('{warning}Back up first.{warning}')).toBe('> **Warning**\n>\n> Back up first.');
  });

  it('keeps a line break inside a paragraph, and a paragraph break between them', () => {
    expect(wikiToMarkdown('One\nTwo\n\nThree\n* item')).toBe('One  \nTwo\n\nThree\n- item');
  });

  it('never throws on odd input', () => {
    expect(wikiToMarkdown('')).toBe('');
    expect(wikiToMarkdown('{code}\nnever closed')).toBe('```\nnever closed\n```');
    expect(wikiToMarkdown('|| half a row\n[broken|')).toBe('|| half a row  \n[broken|');
  });
});
