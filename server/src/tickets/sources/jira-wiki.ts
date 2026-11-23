// Jira's wiki markup as Markdown: `h2.`, `*bold*`, `{{mono}}`, `{code:js}`, `#` numbered lists,
// `[text|url]`, `||tables||`, `{quote}`, `{panel}`, `[~mentions]`. Used for a description or comment
// Jira holds as plain text that was written in that markup (jira-adf.ts decides when). Line based and
// forgiving: what it does not know stays as written, and it never throws. Pure.

/** Marks nothing but wiki markup has: a heading line, a block macro, a header row, a `[text|url]` link. */
const WIKI_SIGNS: readonly RegExp[] = [/^\s*h[1-6]\.\s+\S/m, /\{(code|noformat|quote|panel)(:[^}\n]*)?\}/, /^\s*\|\|.+\|\|\s*$/m, /\[[^\]|\n]+\|\s*https?:\/\/[^\]\s]+\]/];

/** Whether plain text reads as Jira wiki markup and not as Markdown. Pure. */
export function looksLikeWiki(text: string): boolean {
  return WIKI_SIGNS.some((sign) => sign.test(text));
}

const PANELS: Record<string, string> = { info: 'Info', note: 'Note', warning: 'Warning', tip: 'Tip' };
const BLOCK_MACRO = /\{(code|noformat|quote|panel|info|note|warning|tip)(?::([^}\n]*))?\}/g;
const MACRO_LINE = /^\{(code|noformat|quote|panel|info|note|warning|tip)(?::([^}\n]*))?\}$/;
const LIST = /^\s*([*#]+|-)\s+(.*)$/;
const HEADER_ROW = /^\s*\|\|(.*)\|\|\s*$/;
const ROW = /^\s*\|(.*)\|\s*$/;

/** A macro's settings (`title=Notes|borderStyle=solid`, or a bare `js`) as a record; the bare one under `''`. */
function settings(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw ?? '').split('|')) {
    const at = part.indexOf('=');
    if (at < 0) out[''] = part.trim();
    else out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}

/** One line's inline markup. `{{mono}}` spans are converted first and nothing inside them is touched. */
export function wikiInline(line: string): string {
  return line
    .split(/(\{\{.+?\}\})/g)
    .map((piece, i) => {
      if (i % 2 === 1) {
        const code = piece.slice(2, -2);
        return code.includes('`') ? `\`\` ${code} \`\`` : `\`${code}\``;
      }
      return piece
        .replace(/\{color(?::[^}\n]*)?\}/g, '')
        .replace(/\[~(?:accountid:)?([^\]\n]+)\]/g, '@$1')
        .replace(/\[([^\]|\n]+)\|\s*([^\]|\s]+)(?:\|[^\]\n]*)?\]/g, '[$1]($2)')
        .replace(/\[((?:https?:\/\/|mailto:)[^\]\s]+)\]/g, '<$1>')
        .replace(/(^|[\s(>|])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?=$|[\s.,;:!?)|])/g, '$1**$2**')
        .replace(/(^|[\s(>|])-(?=[^\s-])([^\n]*?[^\s-])-(?=$|[\s.,;:!?)|])/g, '$1~~$2~~')
        .replace(/(^|[\s(>|])\?\?(?=\S)(.+?)(?<=\S)\?\?(?=$|[\s.,;:!?)|])/g, '$1*$2*')
        .replace(/(^|\s)!([^!|\s]+\.[^!|\s]+)(?:\|[^!\n]*)?!(?=$|[\s.,;:)])/g, (_, lead: string, src: string) => `${lead}${/^https?:\/\//i.test(src) ? `![](${src})` : `*(attachment: ${src})*`}`)
        .replace(/\\\\\s*/g, '  \n');
    })
    .join('');
}

/** How far a list item at this marker sits in: under the text of the item above it. */
const indentOf = (marker: string): string => [...marker.slice(0, -1)].map((c) => (c === '#' ? '   ' : '  ')).join('');

const cells = (row: string, by: string): string[] => row.split(by).map((c) => wikiInline(c.trim()).replace(/\|/g, '\\|'));
const tableLine = (row: string[]): string => `| ${row.join(' | ')} |`;

/** Text written in Jira's wiki markup, as Markdown. Pure. */
export function wikiToMarkdown(wiki: string): string {
  // A block macro always gets a line of its own, so `{code}one line{code}` is read like the long form.
  const lines = wiki.replace(/\r\n?/g, '\n').replace(BLOCK_MACRO, '\n$&\n').split('\n');
  const out: string[] = [];
  let code: string | null = null; // the macro that opened the code block being copied
  let quote = '';
  let inTable = false;
  const isBlank = (line: string | undefined) => line === undefined || line === '' || line === '>';
  const push = (line: string) => {
    // Outside a code block one blank line is enough, and nothing starts with one.
    if (!line && code === null && isBlank(out.at(-1))) return;
    out.push(line ? quote + line : quote.trimEnd());
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const macro = MACRO_LINE.exec(line.trim());
    if (code !== null) {
      if (macro && macro[1] === code) {
        while (out.at(-1)?.trim() === quote.trim()) out.pop();
        push('```');
        code = null;
      } else if (line.trim() || !out.at(-1)?.startsWith(`${quote}\`\`\``)) push(line);
      continue;
    }
    if (macro) {
      const [, name, raw] = macro;
      const set = settings(raw);
      if (name === 'code' || name === 'noformat') {
        code = name!;
        if (set.title) push(`**${set.title}**`), push('');
        push(`\`\`\`${name === 'code' ? (set.language ?? set[''] ?? '').replace(/\s+/g, '') : ''}`);
      } else if (quote) {
        while (out.at(-1) === '>') out.pop();
        quote = '';
        push('');
      } else {
        push('');
        quote = '> ';
        const title = set.title ?? (name === 'quote' || name === 'panel' ? '' : PANELS[name!]);
        if (title) push(`**${title}**`), push('');
      }
      continue;
    }
    const wasTable = inTable;
    inTable = false;
    const heading = /^\s*h([1-6])\.\s+(.*)$/.exec(line);
    const item = LIST.exec(line);
    const header = HEADER_ROW.exec(line);
    const row = header ? null : ROW.exec(line);
    if (heading) push(`${'#'.repeat(Number(heading[1]))} ${wikiInline(heading[2]!.trim())}`);
    else if (/^\s*bq\.\s+/.test(line)) push(`> ${wikiInline(line.replace(/^\s*bq\.\s+/, ''))}`);
    else if (/^\s*-{4,}\s*$/.test(line)) push('---');
    else if (item) {
      const marker = item[1]!;
      push(`${indentOf(marker)}${marker.endsWith('#') ? '1.' : '-'} ${wikiInline(item[2]!)}`);
    } else if (header) {
      const head = cells(header[1]!, '||');
      push(tableLine(head));
      push(tableLine(head.map(() => '---')));
      inTable = true;
    } else if (row) {
      const body = cells(row[1]!, '|');
      // Markdown has no table without a header row: one with nothing in it stands in.
      if (!wasTable) push(tableLine(body.map(() => ''))), push(tableLine(body.map(() => '---')));
      push(tableLine(body));
      inTable = true;
    } else {
      // In wiki markup a line break is a line break; Markdown needs two spaces to keep one.
      const next = lines[i + 1] ?? '';
      const plainNext = next.trim() !== '' && !MACRO_LINE.test(next.trim()) && !LIST.test(next) && !ROW.test(next) && !/^\s*(h[1-6]|bq)\.\s/.test(next);
      push(wikiInline(line.trimEnd()) + (line.trim() && plainNext ? '  ' : ''));
    }
  }
  if (code !== null) out.push(`${quote}\`\`\``);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
