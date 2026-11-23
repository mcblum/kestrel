// Jira's document format (ADF, what REST version 3 gives for a description or a comment) as
// Markdown, the one format every ticket source hands over (docs/designs/tickets.md, "Ticket text is
// Markdown"). Text is passed through as written, not escaped: a ticket whose author typed Markdown
// into Jira then reads as Markdown too. A document that is nothing but plain paragraphs is taken as
// the text it is: through `wikiToMarkdown` when it reads as Jira's older wiki markup, else as Markdown. Forgiving: an unknown node gives
// what text it holds, and nothing here throws. Pure.
import { looksLikeWiki, wikiToMarkdown } from './jira-wiki.ts';

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const kids = (node: Node): Node[] => (Array.isArray(node.content) ? node.content.filter(isNode) : []);
const attrs = (node: Node): Node => (isNode(node.attrs) ? node.attrs : {});
const marksOf = (node: Node): Node[] => (Array.isArray(node.marks) ? node.marks.filter(isNode) : []);

const PANEL_LABEL: Record<string, string> = { info: 'Info', note: 'Note', warning: 'Warning', error: 'Error', success: 'Success', tip: 'Tip' };
const LIST_ROW = /^\s*(?:[-*+#]+|\d+[.)])\s+\S/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;

/** A code span around `code`, with a fence longer than any run of backticks inside it. */
function codeSpan(code: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = code.startsWith('`') || code.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${code}${pad}${fence}`;
}

/** A link's address as Markdown takes it: spaces and brackets cannot end it early. */
const address = (href: string): string => href.trim().replace(/\s/g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');

/** One text node with its marks. The spaces at its ends stay outside the marks, where Markdown wants them. */
function textNode(node: Node): string {
  const raw = str(node.text);
  const marks = marksOf(node);
  if (marks.length === 0 || !raw.trim()) return raw;
  const [, lead = '', core = '', trail = ''] = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw) ?? [];
  const has = (type: string) => marks.some((m) => m.type === type);
  let out = has('code') ? codeSpan(core) : core;
  if (has('strike')) out = `~~${out}~~`;
  if (has('em')) out = `*${out}*`;
  if (has('strong')) out = `**${out}**`;
  const link = marks.find((m) => m.type === 'link');
  const href = link ? str(attrs(link).href) : '';
  if (href) out = out === href ? `<${address(href)}>` : `[${out}](${address(href)})`;
  return `${lead}${out}${trail}`;
}

function inlineNode(node: Node): string {
  const a = attrs(node);
  switch (node.type) {
    case 'text':
      return textNode(node);
    case 'hardBreak':
      return '  \n';
    case 'mention':
      return str(a.text) || '@someone';
    case 'emoji':
      return str(a.text) || str(a.shortName);
    case 'inlineCard':
    case 'blockCard':
    case 'embedCard':
      return str(a.url) ? `<${address(str(a.url))}>` : '';
    case 'status':
      return str(a.text) ? codeSpan(str(a.text)) : '';
    case 'date': {
      const at = Number(a.timestamp);
      return Number.isFinite(at) && at > 0 ? new Date(at).toISOString().slice(0, 10) : '';
    }
    case 'media':
    case 'mediaInline':
      return `*(attachment${str(a.alt) ? `: ${str(a.alt)}` : ''})*`;
    default:
      return inline(kids(node));
  }
}

const inline = (nodes: Node[]): string => nodes.map(inlineNode).join('');

/** Every line after the first moved in under a list marker or a quote's first line. */
const hang = (text: string, indent: string): string => text.split('\n').map((line, i) => (i === 0 || !line ? line : indent + line)).join('\n');

const quoted = (text: string): string => text.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n');

function listItems(node: Node, marker: (index: number, item: Node) => string): string {
  return kids(node)
    .map((item, i) => {
      const lead = marker(i, item);
      const parts = kids(item);
      // A task or decision item holds its text directly, not in a paragraph.
      const body = parts.some((p) => p.type === 'text' || p.type === 'hardBreak' || p.type === 'mention') ? inline(parts) : blocks(parts, true);
      return `${lead} ${hang(body, ' '.repeat(lead.length + 1))}`;
    })
    .join('\n');
}

/** One cell on one line: a table row cannot hold a line break or a bare bar. */
const cell = (node: Node): string => blocks(kids(node)).replace(/\s*\n+\s*/g, ' ').replace(/\|/g, '\\|').trim();

function table(node: Node): string {
  const rows = kids(node).filter((row) => row.type === 'tableRow').map((row) => kids(row));
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((row) => row.length));
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  const headed = rows[0]!.length > 0 && rows[0]!.every((c) => c.type === 'tableHeader');
  const head = headed ? rows[0]!.map(cell) : [];
  const body = (headed ? rows.slice(1) : rows).map((row) => line(row.map(cell)));
  return [line(head), line(Array.from({ length: width }, () => '---')), ...body].join('\n');
}

function block(node: Node): string {
  const a = attrs(node);
  switch (node.type) {
    case 'paragraph':
      return inline(kids(node));
    case 'heading':
      return `${'#'.repeat(Math.min(6, Math.max(1, Number(a.level) || 1)))} ${inline(kids(node)).replace(/\s*\n\s*/g, ' ')}`;
    case 'bulletList':
    case 'decisionList':
      return listItems(node, () => '-');
    case 'orderedList': {
      const first = Number(a.order) >= 0 ? Number(a.order) : 1;
      return listItems(node, (i) => `${first + i}.`);
    }
    case 'taskList':
      return listItems(node, (_, item) => `- [${attrs(item).state === 'DONE' ? 'x' : ' '}]`);
    case 'codeBlock': {
      const code = kids(node).map((n) => str(n.text)).join('');
      const fence = '`'.repeat(Math.max(3, ...(code.match(/`{3,}/g) ?? []).map((run) => run.length + 1)));
      return `${fence}${str(a.language).replace(/\s+/g, '')}\n${code}\n${fence}`;
    }
    case 'blockquote':
      return quoted(blocks(kids(node)));
    case 'panel': {
      const label = PANEL_LABEL[str(a.panelType)];
      return quoted([...(label ? [`**${label}**`] : []), blocks(kids(node))].join('\n\n'));
    }
    case 'expand':
    case 'nestedExpand':
      return [...(str(a.title) ? [`**${str(a.title)}**`] : []), blocks(kids(node))].filter(Boolean).join('\n\n');
    case 'rule':
      return '---';
    case 'table':
      return table(node);
    case 'mediaSingle':
    case 'mediaGroup':
      return kids(node).map(inlineNode).join(' ');
    default:
      // A node Kestrel does not know: its blocks if it holds any, else its text.
      return kids(node).some((n) => n.type === 'text') || kids(node).length === 0 ? inlineNode(node) : blocks(kids(node));
  }
}

/** Blocks one after another. In a list item (`tight`) a list sits right under its line. */
function blocks(nodes: Node[], tight = false): string {
  let out = '';
  nodes.forEach((node, i) => {
    const text = block(node);
    if (!text.trim()) return;
    const isList = /List$/.test(str(node.type));
    out += out ? (tight && isList && i > 0 ? '\n' : '\n\n') + text : text;
  });
  return out;
}

/**
 * The text of a document that is only plain paragraphs (what Jira keeps when markup is pasted or sent
 * as plain text), or null when it has any formatting of its own. Rows of a table and items of a list
 * that arrived as paragraphs are put back on neighbouring lines.
 */
function plainText(doc: Node): string | null {
  const paragraphs: string[] = [];
  for (const node of kids(doc)) {
    if (node.type !== 'paragraph') return null;
    let line = '';
    for (const part of kids(node)) {
      if (part.type === 'hardBreak') line += '\n';
      else if (part.type === 'inlineCard') line += str(attrs(part).url);
      else if (part.type === 'text' && marksOf(part).every((m) => m.type === 'link' && str(attrs(m).href).replace(/\/$/, '') === str(part.text).trim().replace(/\/$/, ''))) line += str(part.text);
      else return null;
    }
    if (line.trim()) paragraphs.push(line);
  }
  let out = '';
  paragraphs.forEach((text, i) => {
    const before = paragraphs[i - 1]?.split('\n').at(-1) ?? '';
    const first = text.split('\n')[0]!;
    const together = (TABLE_ROW.test(before) && TABLE_ROW.test(first)) || (LIST_ROW.test(before) && LIST_ROW.test(first));
    out += i === 0 ? text : (together ? '\n' : '\n\n') + text;
  });
  return out;
}

/** A description or comment body as Jira gives it (an ADF document; a string from an older answer) as Markdown. Pure. */
export function adfToMarkdown(doc: unknown): string {
  if (typeof doc === 'string') return looksLikeWiki(doc) ? wikiToMarkdown(doc) : doc.trim();
  if (!isNode(doc)) return '';
  const plain = plainText(doc);
  if (plain !== null && looksLikeWiki(plain)) return wikiToMarkdown(plain);
  // Plain paragraphs that are not wiki markup are taken as Markdown; a line break typed in Jira stays one.
  if (plain !== null) return plain.replace(/([^\n])\n(?=[^\n])/g, '$1  \n').trim();
  return blocks(kids(doc)).replace(/\n{3,}/g, '\n\n').trim();
}
