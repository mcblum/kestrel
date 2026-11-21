// One edit to the message box's draft, and the automatic parts that go with it (Matt, 2026-11-19:
// the box is "a mini markdown editor of sorts that auto-formats"). The draft is plain markdown and
// stays the only thing kept: an edit is a set of replacements of its characters, and the automatic
// parts (numbered lists renumbered) are more replacements made in the same step, so undo takes
// them back together and the caret stays with the text the user is typing. Pure.
import { visibleOffset } from './fence-blocks.ts';
import { arrowOutOfBlock, blockBreak, deleteAtBlockEdge, instantBlock } from './fence-edits.ts';
import { hasOpenFence, openRepairs, pairRepairs } from './fence-repair.ts';
import { breakInList, type DraftEdit } from './list-lines.ts';
import { nestItems, renumberEdits } from './list-renumber.ts';

/** The draft and its selection. */
export interface DraftState {
  text: string;
  start: number;
  end: number;
}

/** What the user did: replacements in the text as it was, and where the selection goes after them (default: after the last one). */
export interface Change {
  edits: readonly DraftEdit[];
  start?: number;
  end?: number;
}

const byStart = (a: DraftEdit, b: DraftEdit) => a.start - b.start;

/** The text with `edits` made (they do not overlap; any order). */
export function applyEdits(text: string, edits: readonly DraftEdit[]): string {
  let out = '';
  let at = 0;
  for (const edit of [...edits].sort(byStart)) {
    out += text.slice(at, edit.start) + edit.inserted;
    at = edit.end;
  }
  return out + text.slice(at);
}

/**
 * Where `offset` is after `edits`. Text inserted exactly at it goes after it (the caret stays
 * before a closing fence put in where it is); inside replaced text it keeps its place up to the
 * end of the new text (a number that grew from 9 to 10 keeps the caret after it).
 */
export function mapOffset(offset: number, edits: readonly DraftEdit[]): number {
  let shift = 0;
  for (const edit of [...edits].sort(byStart)) {
    if (offset < edit.start || (offset === edit.start && edit.start === edit.end)) break;
    if (offset >= edit.end) shift += edit.inserted.length - (edit.end - edit.start);
    else return edit.start + shift + Math.min(offset - edit.start, edit.inserted.length);
  }
  return offset + shift;
}

/** The span of the text after `edits` that they wrote: from the first one's start to the last one's end. */
function touched(edits: readonly DraftEdit[]): { from: number; to: number } {
  const sorted = [...edits].sort(byStart);
  let shift = 0;
  let from = Number.POSITIVE_INFINITY;
  let to = 0;
  for (const edit of sorted) {
    from = Math.min(from, edit.start + shift);
    to = edit.start + shift + edit.inserted.length;
    shift += edit.inserted.length - (edit.end - edit.start);
  }
  return { from: Number.isFinite(from) ? from : 0, to };
}

/** The end of the last edit, in the text after them: where the caret goes when the change does not say. */
const afterLast = (edits: readonly DraftEdit[]): number => touched(edits).to;

/** The draft part-way through a change: its text, the selection, and the span the user's edit wrote. */
interface Working extends DraftState {
  from: number;
  to: number;
}

/** One automatic part: more edits to the working text, which everything held moves with. */
function then(state: Working, edits: readonly DraftEdit[]): Working {
  if (edits.length === 0) return state;
  const map = (offset: number) => mapOffset(offset, edits);
  return { text: applyEdits(state.text, edits), start: map(state.start), end: map(state.end), from: map(state.from), to: map(state.to) };
}

const FENCE_LINE = /^ {0,3}`{3}/;

/** Whether the change is typing on an opening fence line before Return: one edit within one line, on a line that starts with ```. */
function typingFence(text: string, edits: readonly DraftEdit[], edited: string, to: number): boolean {
  if (edits.length !== 1) return false;
  const [edit] = edits;
  if (edit!.inserted.includes('\n') || text.slice(edit!.start, edit!.end).includes('\n')) return false;
  return FENCE_LINE.test(edited.slice(edited.lastIndexOf('\n', to - 1) + 1));
}

const ONLY_BACKTICKS = /^`{1,3}$/;
/** Whether the change put in backticks and nothing else: one typed, or the three arriving together (some input methods send them so). */
const typedBacktick = (edits: readonly DraftEdit[]): boolean => edits.length === 1 && ONLY_BACKTICKS.test(edits[0]!.inserted);

/**
 * Make `change` to `text` with its automatic parts, in this order: code fences kept in pairs
 * (fence-repair.ts), the numbered lists it touched renumbered (list-renumber.ts), and the
 * selection moved off a hidden fence line into the code (fence-blocks.ts). The selection follows
 * the text it was in.
 */
export function applyChange(text: string, change: Change): DraftState {
  const edited = applyEdits(text, change.edits);
  const caret = afterLast(change.edits);
  const start = change.start ?? caret;
  const end = change.end ?? change.start ?? caret;
  if (change.edits.length === 0) return { text, start: visibleOffset(text, start), end: visibleOffset(text, end) };
  const typing = typingFence(text, change.edits, edited, caret);
  let state: Working = { text: edited, start, end, ...touched(change.edits) };
  if (!typing) {
    state = then(state, pairRepairs(text, change.edits, edited, (offset) => mapOffset(offset, change.edits), state.to));
    state = then(state, openRepairs(hasOpenFence(text), state.text, state.to));
  }
  state = then(state, renumberEdits(state.text, state.from, state.to));
  if (typing) {
    // The third backtick on a line of its own: the block is made now, as part of the same edit.
    const made = typedBacktick(change.edits) && state.start === state.end ? instantBlock(state.text, state.start) : null;
    return made ? applyChange(state.text, made) : { text: state.text, start: state.start, end: state.end };
  }
  return { text: state.text, start: visibleOffset(state.text, state.start), end: visibleOffset(state.text, state.end) };
}

/** The edit that turned `before` into `after` (the browser typed it): the changed middle, between what both share at the ends. */
export function diffEdit(before: string, after: string, caret: number): DraftEdit {
  let head = 0;
  const max = Math.min(before.length, after.length);
  // The shared start stops at the caret, so a letter typed after the same letter counts where it was typed.
  while (head < max && head < caret && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < max - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  return { start: head, end: before.length - tail, inserted: after.slice(head, after.length - tail) };
}

/** A line break typed with the selection `start`..`end`: a code block made or left, the next list item, the end of a list, or a plain break. */
export function lineBreakChange(text: string, start: number, end: number): Change {
  const block = blockBreak(text, start, end);
  if (block) return block;
  const inList = start === end ? breakInList(text, start) : null;
  return { edits: [inList ?? { start, end, inserted: '\n' }] };
}

/**
 * Backspace (or Delete, `forward`) with the selection `start`..`end`, at the edge of a code block
 * whose fences are hidden (fence-edits.ts). Null where the delete is an ordinary one.
 */
export function deleteChange(text: string, start: number, end: number, forward: boolean): Change | null {
  return start === end ? deleteAtBlockEdge(text, start, forward) : null;
}

/** Arrow Down or Up with the caret at `caret`: a way out of a code block at the end or start of the draft, or null. */
export function arrowChange(text: string, caret: number, down: boolean): Change | null {
  return arrowOutOfBlock(text, caret, down);
}

/** Tab or Shift Tab with the selection `start`..`end`: list items nest or un-nest; null when there are none. */
export function tabChange(text: string, start: number, end: number, outdent: boolean): Change | null {
  const nest = nestItems(text, start, end, outdent);
  return nest && { edits: [nest.edit], start: nest.start, end: nest.end };
}
