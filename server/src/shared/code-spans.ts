// Which parts of a message the user writes are code: `inline code` and fenced blocks (three or more
// backticks on a line of their own, an optional language after them, up to a closing line of at
// least as many backticks). Used to style the message box as the user types and the message once
// sent; nothing here changes the text. Rules:
// - a fence left open runs to the end of the text;
// - inside a fence everything is literal, backticks included;
// - inline code is a run of backticks closed by a run of the same length on the same line; a run
//   with no partner (a single stray backtick) is plain text.
// Pure.

export interface CodePiece {
  kind: 'text' | 'code';
  /** The text as written, backticks included: the pieces of a line join back into the line. */
  text: string;
  /** For code: how many backticks open and close it. */
  ticks?: number;
}

export type FenceRole = 'open' | 'body' | 'close';

export interface CodeLine {
  /** The line as written, without its line break. */
  text: string;
  /** Set on the lines of a fenced block. */
  fence?: FenceRole;
  /** The last line of its fenced block (the closing line, or the text's last line when the fence is left open). */
  fenceEnd?: boolean;
  /** Inline code and plain text, for a line outside any fence. */
  pieces: CodePiece[];
}

const OPEN = /^ {0,3}(`{3,})([^`]*)$/;
const CLOSE = /^ {0,3}(`{3,})\s*$/;

/** A line outside fences, split into plain text and inline code. */
export function inlinePieces(line: string): CodePiece[] {
  const pieces: CodePiece[] = [];
  const runs = [...line.matchAll(/`+/g)].map((m) => ({ at: m.index, len: m[0].length }));
  let from = 0;
  let i = 0;
  while (i < runs.length) {
    const open = runs[i]!;
    const closeAt = runs.findIndex((r, j) => j > i && r.len === open.len);
    if (closeAt < 0) {
      i++;
      continue;
    }
    const close = runs[closeAt]!;
    if (open.at > from) pieces.push({ kind: 'text', text: line.slice(from, open.at) });
    pieces.push({ kind: 'code', text: line.slice(open.at, close.at + close.len), ticks: open.len });
    from = close.at + close.len;
    i = closeAt + 1;
  }
  if (from < line.length || pieces.length === 0) pieces.push({ kind: 'text', text: line.slice(from) });
  return pieces;
}

/** Every line of `text`, with its fence role or its inline pieces. */
export function codeLines(text: string): CodeLine[] {
  const lines = text.split('\n');
  const out: CodeLine[] = [];
  let fence = 0; // the opening run's length while inside a fence
  lines.forEach((line, i) => {
    const last = i === lines.length - 1;
    if (fence) {
      const close = CLOSE.exec(line);
      if (close && close[1]!.length >= fence) {
        fence = 0;
        out.push({ text: line, fence: 'close', fenceEnd: true, pieces: [] });
      } else out.push({ text: line, fence: 'body', ...(last ? { fenceEnd: true } : {}), pieces: [] });
      return;
    }
    const open = OPEN.exec(line);
    if (open) {
      fence = open[1]!.length;
      out.push({ text: line, fence: 'open', ...(last ? { fenceEnd: true } : {}), pieces: [] });
      return;
    }
    out.push({ text: line, pieces: inlinePieces(line) });
  });
  return out;
}

/** A sent message in blocks: prose (with its inline code) and fenced code. */
export type CodeBlockPart = { kind: 'prose'; lines: CodePiece[][] } | { kind: 'fence'; lang: string | null; code: string };

const LANG = /^[\w+#.-]{1,24}$/;

/** The language named on a fence's opening line when it reads as one ("ts", "c++", "objective-c"), lower case; else null. The box's label and the sent message's agree. */
export function fenceLanguage(line: string): string | null {
  const name = OPEN.exec(line)?.[2]!.trim().split(/\s+/)[0] ?? '';
  return LANG.test(name) ? name.toLowerCase() : null;
}
const fenceLang = fenceLanguage;

/** The blocks of a message, in order. A fence's code is its lines between the fence lines. */
export function codeBlocks(text: string): CodeBlockPart[] {
  const parts: CodeBlockPart[] = [];
  let body: string[] | null = null;
  let lang: string | null = null;
  for (const line of codeLines(text)) {
    if (line.fence === 'open') {
      body = [];
      lang = fenceLang(line.text);
    } else if (line.fence === 'body') body!.push(line.text);
    else if (!line.fence) {
      const prev = parts.at(-1);
      if (prev?.kind === 'prose') prev.lines.push(line.pieces);
      else parts.push({ kind: 'prose', lines: [line.pieces] });
    }
    if (line.fenceEnd) {
      parts.push({ kind: 'fence', lang, code: body!.join('\n') });
      body = null;
    }
  }
  return parts;
}
