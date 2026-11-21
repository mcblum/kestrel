// Keeping the fences of the message box's code blocks in pairs (fence-blocks.ts). With the fence
// lines hidden, an edit can take one fence of a block and leave its partner, which would then
// swallow the rest of the message as code. After every edit, as part of it:
// 1. A block that lost its closing fence (an edit from inside its code to past its end) is closed
//    again after the line where the edit ended: the code above stays code.
// 2. A block that lost its opening fence (an edit from before it into its code) loses its closing
//    fence too: what is left of its code joins the text it was joined to.
// 3. A fence left open after that is closed: at the end of the text when the draft already had an
//    open fence before the edit (a draft restored that way: it was shown as a block to the end,
//    and stays so); after the line where the edit ended when the edit put it in (pasted text with
//    an unclosed fence); and removed when it lies past the edit (a closing fence whose block lost
//    its opening one to the edit).
// Nothing is repaired while a fence line is being typed (``` and its language, before Return):
// draft-edit.ts decides that and calls these in order. Pure.
import { fenceBlocks } from './fence-blocks.ts';
import type { DraftEdit } from './list-lines.ts';

interface Span {
  start: number;
  end: number;
}

/** Whether a line (its text `start`..`end`) is still a line of its own, unchanged, after `edit`. */
export function lineSurvives(line: Span, edit: DraftEdit): boolean {
  const { start, end, inserted } = edit;
  if (end < line.start || start > line.end) return true;
  if (end === line.start) return inserted === '' ? start === end : inserted.endsWith('\n');
  if (start === line.end) return inserted === '' ? start === end : inserted.startsWith('\n');
  return false;
}

const survivesAll = (line: Span, edits: readonly DraftEdit[]) => edits.every((edit) => lineSurvives(line, edit));
const lineEndOf = (text: string, offset: number): number => {
  const next = text.indexOf('\n', offset);
  return next === -1 ? text.length : next;
};
const lineStartOf = (text: string, offset: number): number => text.lastIndexOf('\n', offset - 1) + 1;

/** A closing fence for `block` after the line of `text` that holds `offset` (with an empty line of code if that line is the opening one). */
function closeAfter(text: string, offset: number, ticks: string, openStart: number): DraftEdit {
  const at = lineEndOf(text, offset);
  return { start: at, end: at, inserted: `${lineStartOf(text, offset) === openStart ? '\n' : ''}\n${ticks}` };
}

/** The line `start`..`end` of `text` removed with one of its line breaks. */
function removeLine(text: string, start: number, end: number): DraftEdit {
  return start > 0 ? { start: start - 1, end, inserted: '' } : { start, end: Math.min(end + 1, text.length), inserted: '' };
}

/**
 * Rules 1 and 2: the blocks of `before` that `edits` broke, mended in `after` (which is `before`
 * with `edits` made). `map` takes an offset of `before` to `after`; `editEnd` is where the edits
 * ended in `after`. The repairs are in `after`'s offsets, to be made together.
 */
export function pairRepairs(before: string, edits: readonly DraftEdit[], after: string, map: (offset: number) => number, editEnd: number): DraftEdit[] {
  return fenceBlocks(before).flatMap((block): DraftEdit[] => {
    if (block.closeStart === null) return [];
    const openOk = survivesAll({ start: block.openStart, end: block.openEnd }, edits);
    const closeOk = survivesAll({ start: block.closeStart, end: block.closeEnd }, edits);
    if (openOk === closeOk) return [];
    if (openOk) return [closeAfter(after, editEnd, block.ticks, map(block.openStart))];
    const start = map(block.closeStart);
    return [removeLine(after, start, start + (block.closeEnd - block.closeStart))];
  });
}

/** Rule 3: the repair of the fence `after` leaves open, if any, given whether the draft had one open before the edit. */
export function openRepairs(hadOpen: boolean, after: string, editEnd: number): DraftEdit[] {
  const open = fenceBlocks(after).find((b) => b.closeStart === null);
  if (!open) return [];
  if (hadOpen) return [{ start: after.length, end: after.length, inserted: `${after.endsWith('\n') ? '' : '\n'}${open.ticks}` }];
  if (open.openStart > lineEndOf(after, editEnd)) return [removeLine(after, open.openStart, open.openEnd)];
  return [closeAfter(after, editEnd, open.ticks, open.openStart)];
}

/** Whether `text` has a fence left open. */
export const hasOpenFence = (text: string): boolean => fenceBlocks(text).some((b) => b.closeStart === null);
