// Markdown as plain text, for "Copy text" on an agent's response: headings, emphasis and quote
// marks dropped, links and pictures reduced to their text, code kept as it is (without fences or
// backticks), list items as plain lines (a numbered item keeps its number), tables as lines of
// tab-separated cells. Line based and forgiving: it never throws on odd markdown. Pure.

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+\s*)?$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const BULLET = /^(\s*)[-*+]\s+(?:\[[ xX]\]\s+)?/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** One line of prose without its inline markup. Code spans keep their content untouched. */
export function inlineText(line: string): string {
  const pieces = line.split(/(`+[^`]*?`+)/g);
  return pieces
    .map((piece, i) => {
      if (i % 2 === 1) return piece.replace(/^`+\s?|\s?`+$/g, '');
      return piece
        // Escaped characters are set aside first, so they are never read as markup.
        .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, (_, c: string) => `\uE000${c.charCodeAt(0)}\uE001`)
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
        .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
        .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
        .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
        .replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?!\w)/g, '$1$2')
        .replace(/(^|[^\w])_(?=\S)([^_]+?)(?<=\S)_(?!\w)/g, '$1$2')
        .replace(/\uE000(\d+)\uE001/g, (_, code: string) => String.fromCharCode(Number(code)));
    })
    .join('');
}

const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const tableCells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => inlineText(cell.trim()))
    .join('\t');

function proseLine(line: string): string | null {
  if (RULE.test(line)) return null;
  if (TABLE_DIVIDER.test(line) && line.includes('-') && line.includes('|')) return null;
  if (isTableRow(line)) return tableCells(line);
  const heading = HEADING.exec(line);
  if (heading) return inlineText(heading[1]!);
  let rest = line;
  while (QUOTE.test(rest)) rest = rest.replace(QUOTE, '');
  rest = rest.replace(BULLET, '$1');
  return inlineText(rest);
}

/** The text of a markdown document, without its formatting. */
export function markdownToText(markdown: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
      else out.push(line);
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    const text = proseLine(line);
    if (text !== null) out.push(text);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
