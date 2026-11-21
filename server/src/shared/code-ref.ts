// A code block by where it is: the offset of its opening fence in a message's text. "Open in a tab"
// (Matt, 2026-11-19) points a tab at a block this way instead of holding a copy of the code, so the
// tab shows what the conversation holds, grows with a block still being written, and survives a
// reload. The agent's markdown gives each block's offset (the `pre` node's position); a sent
// message's fences are found by `fenceStarts`. Pure.
import { fenceBlocks } from './fence-blocks.ts';

export interface CodeFound {
  /** The first word after the opening fence, as written; null when there is none. */
  lang: string | null;
  code: string;
}

const OPENING = /^(`{3,}|~{3,})[ \t]*([^\s`]*)/;

/** Up to `width` leading spaces or tabs removed: the indentation a list item gave the block. */
const dedent = (line: string, width: number): string => {
  let cut = 0;
  while (cut < width && (line[cut] === ' ' || line[cut] === '\t')) cut++;
  return line.slice(cut);
};

/** The fenced block whose opening fence starts at `offset` of `text`, or null when none does. */
export function codeAt(text: string, offset: number): CodeFound | null {
  if (offset < 0 || offset >= text.length) return null;
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const [first = '', ...rest] = text.slice(offset).split('\n');
  const opening = OPENING.exec(first);
  if (!opening) return null;
  const fence = opening[1]!;
  const closes = (line: string): boolean => {
    const run = line.trim();
    return run.length >= fence.length && [...run].every((char) => char === fence[0]);
  };
  const end = rest.findIndex(closes);
  const body = end === -1 ? rest : rest.slice(0, end);
  return { lang: opening[2] || null, code: body.map((line) => dedent(line, offset - lineStart)).join('\n') };
}

/** Where each fenced block of a sent message starts, in order: the offsets `codeAt` reads them from. */
export function fenceStarts(text: string): number[] {
  return fenceBlocks(text).map((block) => block.openStart + (text.slice(block.openStart).length - text.slice(block.openStart).trimStart().length));
}
