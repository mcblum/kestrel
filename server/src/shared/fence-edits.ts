// What keys do at the edges of a code block in the message box, whose fence lines are not shown
// (fence-blocks.ts). Each returns the change to make, in the same shape as every other edit
// (draft-edit.ts), so it is one step of undo. Pure.
import type { Change } from './draft-edit.ts';
import { highlightLanguage } from './code-highlight.ts';
import { fenceBlocks, hidesFences, type FenceBlock } from './fence-blocks.ts';

const lineStartOf = (text: string, offset: number): number => text.lastIndexOf('\n', offset - 1) + 1;
const lineEndOf = (text: string, offset: number): number => {
  const next = text.indexOf('\n', offset);
  return next === -1 ? text.length : next;
};
const isEmptyLineAt = (text: string, start: number): boolean => start === text.length || text[start] === '\n';

/** The closed block with code whose code holds `caret`. */
const blockAround = (text: string, caret: number): (FenceBlock & { closeStart: number }) | undefined =>
  fenceBlocks(text)
    .filter(hidesFences)
    .find((b) => caret >= b.bodyStart && caret <= b.bodyEnd);

/** A change that only moves the caret. */
const moveTo = (caret: number): Change => ({ edits: [], start: caret });

/**
 * A line break at the end of an opening fence line (``` and an optional language) makes the block:
 * the closing fence goes in after an empty line of code, where the caret goes.
 */
function openBlock(text: string, caret: number): Change | null {
  const block = fenceBlocks(text).find((b) => b.openStart === lineStartOf(text, caret));
  if (!block || caret !== block.openEnd) return null;
  return { edits: [{ start: caret, end: caret, inserted: `\n\n${block.ticks}` }], start: caret + 1 };
}

/**
 * A line break on the empty last line of a block leaves it: that line goes and the caret is on a
 * new line after the block. In a block with only that empty line, the block goes.
 */
function leaveBlock(text: string, caret: number): Change | null {
  const block = blockAround(text, caret);
  if (!block || caret !== block.bodyEnd || lineStartOf(text, caret) !== caret) return null;
  // An empty block stays: the block is made the moment its backticks are typed, and the Return that
  // habit adds after them must not take it away again. Backspace removes an empty block.
  if (block.bodyLines === 1) return moveTo(caret);
  return {
    edits: [
      { start: caret - 1, end: caret, inserted: '' },
      { start: block.closeEnd, end: block.closeEnd, inserted: '\n' },
    ],
  };
}

/**
 * A line break at the end of the only line of a block that names no language, when that line is a
 * language's name ("ts", "python", "sh"): the name becomes the block's language and the line is
 * empty again. So ``` then "ts" then Return still makes a TypeScript block, although the block
 * appeared at the third backtick.
 */
function nameLanguage(text: string, caret: number): Change | null {
  const block = blockAround(text, caret);
  if (!block || block.lang !== null || block.bodyLines !== 1 || caret !== block.bodyEnd) return null;
  const name = text.slice(block.bodyStart, block.bodyEnd);
  if (name !== name.trim() || highlightLanguage(name) === null) return null;
  return {
    edits: [
      { start: block.openEnd, end: block.openEnd, inserted: name },
      { start: block.bodyStart, end: block.bodyEnd, inserted: '' },
    ],
    start: block.bodyStart + name.length,
  };
}

/** What a line break with the caret at `caret` does to code blocks: make one, name its language, leave one, or nothing special (null). */
export function blockBreak(text: string, start: number, end: number): Change | null {
  if (start !== end) return null;
  return openBlock(text, start) ?? nameLanguage(text, start) ?? leaveBlock(text, start);
}

const BARE_FENCE = /^ {0,3}```$/;

/**
 * The third backtick typed on a line of its own makes the code block at once (Matt, 2026-11-19):
 * the closing fence goes in, the caret is on the empty line inside, and neither fence line shows.
 * Null when the line is not just the three backticks, or they close a block and do not open one.
 */
export function instantBlock(text: string, caret: number): Change | null {
  if (!BARE_FENCE.test(text.slice(lineStartOf(text, caret), lineEndOf(text, caret))) || caret !== lineEndOf(text, caret)) return null;
  return openBlock(text, caret);
}

/** Backspace at the start of a block's code: an empty block goes; otherwise the fences go and the code is ordinary text. */
function backspaceIntoOpening(text: string, block: FenceBlock & { closeStart: number }): Change {
  if (block.bodyStart === block.bodyEnd) {
    const start = block.openStart > 0 ? block.openStart - 1 : 0;
    const end = block.openStart > 0 ? block.closeEnd : Math.min(block.closeEnd + 1, text.length);
    return { edits: [{ start, end, inserted: '' }] };
  }
  return {
    edits: [
      { start: block.openStart, end: block.bodyStart, inserted: '' },
      { start: block.closeStart - 1, end: block.closeEnd, inserted: '' },
    ],
    start: block.openStart,
  };
}

/**
 * A single-character delete (`forward` for Delete) next to a hidden fence line, where the
 * browser's own delete would join a fence line to the text beside it and break the block:
 * - Backspace at the start of the code: see backspaceIntoOpening.
 * - Backspace at the start of the line after a block: an empty line goes and the caret is at the
 *   end of the code; on a line with text the caret only moves there.
 * - Delete at the end of the code, or at the end of the line before a block: an empty line beyond
 *   the fence goes; otherwise nothing happens.
 * Null anywhere else: an ordinary delete.
 */
export function deleteAtBlockEdge(text: string, caret: number, forward: boolean): Change | null {
  for (const block of fenceBlocks(text).filter(hidesFences)) {
    const after = block.closeEnd + 1;
    if (!forward && caret === block.bodyStart) return backspaceIntoOpening(text, block);
    if (!forward && caret === after && after <= text.length) return isEmptyLineAt(text, after) ? { edits: [{ start: block.closeEnd, end: after, inserted: '' }], start: block.bodyEnd } : moveTo(block.bodyEnd);
    if (forward && caret === block.bodyEnd) return after <= text.length && isEmptyLineAt(text, after) ? { edits: [{ start: block.closeEnd, end: after, inserted: '' }], start: caret } : moveTo(caret);
    if (forward && block.openStart > 0 && caret === block.openStart - 1) return caret === lineStartOf(text, caret) ? { edits: [{ start: caret, end: caret + 1, inserted: '' }], start: caret } : moveTo(caret);
  }
  return null;
}

/**
 * Arrow Down on the last line of code of a block that ends the draft makes a line after it, and
 * Arrow Up on the first line of a block that starts the draft makes one before it: the caret can
 * always get out of a block. Null anywhere else (the browser moves the caret).
 */
export function arrowOutOfBlock(text: string, caret: number, down: boolean): Change | null {
  const block = blockAround(text, caret);
  if (!block) return null;
  if (down && block.closeEnd === text.length && lineEndOf(text, caret) === block.bodyEnd) return { edits: [{ start: text.length, end: text.length, inserted: '\n' }] };
  if (!down && block.openStart === 0 && lineStartOf(text, caret) === block.bodyStart) return { edits: [{ start: 0, end: 0, inserted: '\n' }], start: 0 };
  return null;
}
