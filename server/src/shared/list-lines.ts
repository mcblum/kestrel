// Which lines of a draft are list items, for the message box (ui MessageInput): a line that starts
// with a bullet ("-", "*", "+") or a number ("1.", "2)") and a space is laid out as a list item,
// its marker in a column of its own and its wrapped lines aligned under its text. The marker is
// characters of the text; the box keeps numbers in order as it is edited (list-renumber.ts). Pure.

export interface ListMarker {
  /** Everything before the item's text: leading spaces, the marker and the spaces after it. */
  length: number;
  /** Leading spaces: how far the item is nested. */
  indent: number;
  /** The marker as typed: "-", "*", "+", "1.", "12)". */
  marker: string;
  ordered: boolean;
}

const LIST_LINE = /^( *)([-*+]|\d{1,4}[.)])( +)/;
/** Deeper nesting than this is laid out as this deep: a draft is not a document. */
export const MAX_LIST_INDENT = 12;

/** The list marker a line starts with, or null when it is not a list item. */
export function listMarker(line: string): ListMarker | null {
  const match = LIST_LINE.exec(line);
  if (!match) return null;
  const marker = match[2]!;
  return { length: match[0].length, indent: Math.min(match[1]!.length, MAX_LIST_INDENT), marker, ordered: /\d/.test(marker) };
}

/**
 * How wide the marker's column is, in em: room for the nesting, the marker and the gap before the
 * text. A number is wider the more digits it has, so "9." and "10." both sit right against their text.
 */
export function markerWidthEm(marker: ListMarker): number {
  const own = marker.ordered ? marker.marker.length * 0.6 + 0.5 : 1.15;
  return Math.round((marker.indent * 0.3 + own) * 100) / 100;
}

/** A change to a draft: the characters `start`..`end` replaced by `inserted`, the caret after it. */
export interface DraftEdit {
  start: number;
  end: number;
  inserted: string;
}

const FENCE = /^ {0,3}(```|~~~)/;
const LEADING_SPACES = /^ */;
/** A task item's box after its marker ("- [ ] ", "- [x] "), as GitHub writes one. */
const TASK_BOX = /^\[[ xX]\] /;
const EMPTY_TASK = '[ ] ';

/** Whether the line that starts at `lineStart` is inside a code fence: a list there is just text. */
function inFence(text: string, lineStart: number): boolean {
  const before = text.slice(0, lineStart).split('\n');
  return before.filter((line) => FENCE.test(line)).length % 2 === 1;
}

/** The marker of the item after this one: the same bullet, or the next number with the same punctuation. Null when the number cannot grow. */
function nextMarker(marker: ListMarker): string | null {
  if (!marker.ordered) return marker.marker;
  const next = `${Number.parseInt(marker.marker, 10) + 1}${marker.marker.slice(-1)}`;
  return listMarker(`${next} `) ? next : null;
}

/**
 * What a line break typed at `caret` does inside a list item (Matt, 2026-11-19): it starts the next
 * item, with the same bullet or the next number and the same nesting, and the rest of the line goes
 * with it. On an item with nothing in it yet, it ends the list instead: the marker goes and the
 * line is left empty. A task item ("- [ ] ") starts an unticked task. Null anywhere else (before
 * or inside the marker, outside a list, in a code fence): an ordinary line break. Items below are
 * renumbered with the edit (list-renumber.ts, by draft-edit.ts), not here.
 */
export function breakInList(text: string, caret: number): DraftEdit | null {
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
  const nextBreak = text.indexOf('\n', caret);
  const lineEnd = nextBreak === -1 ? text.length : nextBreak;
  const line = text.slice(lineStart, lineEnd);
  const marker = listMarker(line);
  if (!marker || caret < lineStart + marker.length || inFence(text, lineStart)) return null;
  const task = TASK_BOX.exec(line.slice(marker.length));
  if (line.slice(marker.length + (task?.[0].length ?? 0)).trim() === '') return { start: lineStart, end: lineEnd, inserted: '' };
  const next = nextMarker(marker);
  if (next === null) return null;
  const nesting = LEADING_SPACES.exec(line)![0];
  return { start: caret, end: caret, inserted: `\n${nesting}${next} ${task ? EMPTY_TASK : ''}` };
}
