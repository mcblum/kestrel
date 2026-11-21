// Code blocks in the message box without their fence lines (Matt, 2026-11-19: "The backtick lines
// should be gone once the code block formatting is inserted into the editor"). The ``` lines stay
// in the text, so the agent gets markdown and a draft round-trips exactly, but the box does not
// show them and the caret never sits on them: a closed block with at least one line of code is
// drawn as a code block alone. A fence left open (a draft restored that way, or ``` being typed)
// and a block with no lines of code keep their fence lines in view, drawn quietly, since there is
// nothing else to show or to put the caret in. Offsets are character offsets into the text;
// a caret position is "on" a line from the line's first character to just after its last. Pure.
import { codeLines, fenceLanguage, type CodePiece } from './code-spans.ts';

export interface FenceBlock {
  /** Offset of the opening fence line, and of the end of its text. */
  openStart: number;
  openEnd: number;
  /** The code: from the first code line's start to the last code line's end (equal when there is none). */
  bodyStart: number;
  bodyEnd: number;
  /** The closing fence line, or null when the fence is left open (it then runs to the end). */
  closeStart: number | null;
  closeEnd: number;
  /** How many lines of code it holds. */
  bodyLines: number;
  /** The opening run of backticks, which a closing fence repeats. */
  ticks: string;
  /** The language named on the opening line, when it reads as one ("ts", "c++", "objective-c"). */
  lang: string | null;
}

const OPEN = /^ {0,3}(`{3,})/;
export { fenceLanguage };

/** Every fenced block of `text`, in order. */
export function fenceBlocks(text: string): FenceBlock[] {
  const blocks: FenceBlock[] = [];
  let open: { start: number; end: number; line: string; lines: number } | null = null;
  let at = 0;
  for (const line of codeLines(text)) {
    const start = at;
    const end = start + line.text.length;
    at = end + 1;
    if (line.fence === 'open') open = { start, end, line: line.text, lines: 0 };
    else if (line.fence === 'body') open!.lines++;
    if (line.fence === 'close' || (line.fenceEnd && open)) {
      const closed = line.fence === 'close';
      const bodyStart = Math.min(open!.end + 1, text.length);
      blocks.push({
        openStart: open!.start,
        openEnd: open!.end,
        bodyStart: open!.lines ? bodyStart : closed ? start : bodyStart,
        bodyEnd: closed ? (open!.lines ? start - 1 : start) : text.length,
        closeStart: closed ? start : null,
        closeEnd: closed ? end : text.length,
        bodyLines: open!.lines,
        ticks: OPEN.exec(open!.line)![1]!,
        lang: fenceLanguage(open!.line),
      });
      open = null;
    }
  }
  return blocks;
}

/** A block whose fence lines are not shown: closed, with code in it. */
export const hidesFences = (block: FenceBlock): block is FenceBlock & { closeStart: number } => block.closeStart !== null && block.bodyLines > 0;

/**
 * Where the caret goes if `offset` is on a hidden fence line: into the code, at its start (from
 * the opening line) or its end (from the closing one). Any other offset is returned as it is.
 */
export function visibleOffset(text: string, offset: number): number {
  for (const block of fenceBlocks(text).filter(hidesFences)) {
    if (offset >= block.openStart && offset <= block.openEnd) return block.bodyStart;
    if (offset >= block.closeStart && offset <= block.closeEnd) return block.bodyEnd;
  }
  return offset;
}

/**
 * The selection `start`..`end` as the draft's offsets. The browser never selects into a hidden
 * fence line, so Select All stops at the code of a block that starts or ends the draft: a
 * selection from the first place the caret can be to the last is the whole draft.
 */
export function wholeSelection(text: string, start: number, end: number): { start: number; end: number } {
  const all = start !== end && start === visibleOffset(text, 0) && end === visibleOffset(text, text.length);
  return all ? { start: 0, end: text.length } : { start, end };
}

/** How the box draws one line of the draft. */
export type BoxLineKind = 'text' | 'code' | 'fence' | 'hidden';

export interface BoxLine {
  /** The line as written, without its line break. */
  text: string;
  kind: BoxLineKind;
  /** The first and last drawn line of a code block (its frame's top and bottom). */
  first?: boolean;
  last?: boolean;
  /** On the first drawn line of a block: the language it was given. */
  lang?: string | null;
  /** Inline code and plain text, for a text line. */
  pieces: CodePiece[];
}

/** Whether `offset` is on one of the block's fence lines. */
const onFence = (block: FenceBlock, offset: number): boolean => (offset >= block.openStart && offset <= block.openEnd) || (block.closeStart !== null && offset >= block.closeStart && offset <= block.closeEnd);

/**
 * Every line of `text` as the box draws it. A block with the caret (`caret`) on one of its fence
 * lines shows them: that happens only while a fence line is being typed, which must stay in view.
 */
export function boxLines(text: string, caret = -1): BoxLine[] {
  const lines = codeLines(text);
  const blocks = fenceBlocks(text);
  let index = 0;
  let block = -1;
  return lines.map((line, i) => {
    if (!line.fence) return { text: line.text, kind: 'text', pieces: line.pieces };
    if (line.fence === 'open') {
      block++;
      index = 0;
    }
    const hidden = hidesFences(blocks[block]!) && !onFence(blocks[block]!, caret);
    const fence = line.fence !== 'body';
    const kind: BoxLineKind = !fence ? 'code' : hidden ? 'hidden' : 'fence';
    if (kind === 'hidden') return { text: line.text, kind, pieces: [] };
    const first = index++ === 0;
    const last = Boolean(line.fenceEnd) || (hidden && lines[i + 1]?.fence === 'close');
    // The label names the language only where the fence line that names it is not in view.
    const lang = hidden ? blocks[block]!.lang : null;
    return { text: line.text, kind, ...(first ? { first: true, lang } : {}), ...(last ? { last: true } : {}), pieces: [] };
  });
}
