// Numbered lists in the message box that keep their own numbers (Matt, 2026-11-19): a run of
// consecutive numbered items at the same nesting counts up by one from its first item's number,
// with the first item's punctuation ("1." or "1)"). The box renumbers the runs an edit touched as
// part of that edit, so a draft restored or a message reused is never changed until it is edited.
// Tab and Shift Tab nest and un-nest list items. Pure.
import { codeLines } from './code-spans.ts';
import { listMarker, type DraftEdit } from './list-lines.ts';

/** One numbered item of a run: where its number sits in the text. */
export interface RunItem {
  /** The line it is on (0-based). */
  line: number;
  /** Offset of its number in the text. */
  at: number;
  /** The marker as typed: "3." or "12)". */
  marker: string;
}

/** How far a nested item moves on Tab, and back on Shift Tab. */
export const NEST_STEP = 2;
const MAX_NUMBER = 9999;
const LEADING = /^ */;

interface Level {
  indent: number;
  /** The run being built at this nesting, or null for a bulleted level. */
  items: RunItem[] | null;
}

const leading = (line: string): number => LEADING.exec(line)![0].length;

/** The levels still open after `line`, which is not a list item: a blank line, a fence or unindented text ends them all, indented text the deeper ones. */
function closeFor(open: readonly Level[], line: string, fence: boolean): Level[] {
  if (fence || line.trim() === '') return [];
  const indent = leading(line);
  return open.filter((level) => level.indent < indent);
}

/**
 * Every run of numbered items in `text`, in order. Items at deeper nesting (numbered or bulleted)
 * do not break the run they sit in; a bullet at the same nesting, a blank line, unindented text
 * or a code fence does. Lines in a code block are never items.
 */
export function orderedRuns(text: string): RunItem[][] {
  const runs: RunItem[][] = [];
  let open: Level[] = [];
  let at = 0;
  codeLines(text).forEach((line, i) => {
    const start = at;
    at += line.text.length + 1;
    const marker = line.fence ? null : listMarker(line.text);
    if (!marker) return void (open = closeFor(open, line.text, Boolean(line.fence)));
    const indent = leading(line.text);
    open = open.filter((level) => level.indent < indent || (level.indent === indent && marker.ordered && level.items));
    if (!marker.ordered) return void (open = [...open, { indent, items: null }]);
    const item = { line: i, at: start + indent, marker: marker.marker };
    const same = open.find((level) => level.indent === indent);
    if (same) same.items!.push(item);
    else {
      const items = [item];
      runs.push(items);
      open = [...open, { indent, items }];
    }
  });
  return runs;
}

/** The changes that make one run count up from its first number with its first punctuation. */
function runEdits(run: readonly RunItem[]): DraftEdit[] {
  const first = Number.parseInt(run[0]!.marker, 10);
  const punctuation = run[0]!.marker.slice(-1);
  return run.flatMap((item, j) => {
    const wanted = `${first + j}${punctuation}`;
    if (first + j > MAX_NUMBER || wanted === item.marker) return [];
    return [{ start: item.at, end: item.at + item.marker.length, inserted: wanted }];
  });
}

/** The line a character offset is on. */
export function lineAt(text: string, offset: number): number {
  let line = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) line++;
  return line;
}

/**
 * The changes that renumber the runs an edit touched: those with an item on the lines from the
 * one before `from` to the one after `to` (offsets in `text`), or spanning them. In text order.
 */
export function renumberEdits(text: string, from: number, to: number): DraftEdit[] {
  const low = lineAt(text, from) - 1;
  const high = lineAt(text, to) + 1;
  return orderedRuns(text)
    .filter((run) => run[0]!.line <= high && run.at(-1)!.line >= low)
    .flatMap(runEdits)
    .sort((a, b) => a.start - b.start);
}

/** The new text of `lines` after nesting (or un-nesting) the list items among them. */
function nestedLines(lines: readonly string[], fenced: readonly boolean[], outdent: boolean): string[] {
  return lines.map((line, i) => {
    if (fenced[i] || !listMarker(line)) return line;
    if (!outdent) return ' '.repeat(NEST_STEP) + line;
    return line.slice(Math.min(NEST_STEP, leading(line)));
  });
}

/** A numbered item nested under an item of the list it was in starts a list of its own, at 1. */
function restartNested(lines: readonly string[], moved: readonly string[], before: string | undefined): string[] {
  return moved.map((line, i) => {
    const marker = listMarker(line);
    const above = i > 0 ? moved[i - 1] : before;
    if (line === lines[i] || !marker?.ordered || above === undefined || !listMarker(above) || leading(above) >= leading(line)) return line;
    const indent = leading(line);
    return `${line.slice(0, indent)}1${marker.marker.slice(-1)}${line.slice(indent + marker.marker.length)}`;
  });
}

/** What Tab (or Shift Tab) does: a replacement of the lines the selection covers, and the selection after it. */
export interface NestChange {
  edit: DraftEdit;
  start: number;
  end: number;
}

/**
 * Tab on the lines of the selection (`start`..`end`) that are list items: each moves in by two
 * spaces, or out by up to two with `outdent`, and the selection moves with its text. A numbered
 * item that becomes the first of a nested list starts it at 1. Null when no line of the selection
 * is a list item (Tab then leaves the box, as it does anywhere else).
 */
export function nestItems(text: string, start: number, end: number, outdent: boolean): NestChange | null {
  const all = codeLines(text);
  const first = lineAt(text, start);
  const last = lineAt(text, end);
  const lines = all.slice(first, last + 1).map((l) => l.text);
  const fenced = all.slice(first, last + 1).map((l) => Boolean(l.fence));
  if (!lines.some((line, i) => !fenced[i] && listMarker(line))) return null;
  const moved = nestedLines(lines, fenced, outdent);
  const next = outdent ? moved : restartNested(lines, moved, first > 0 ? all[first - 1]!.text : undefined);
  const from = all.slice(0, first).reduce((n, l) => n + l.text.length + 1, 0);
  const startOf = (rows: readonly string[], k: number) => from + rows.slice(0, k).reduce((n, l) => n + l.length + 1, 0);
  /** An offset on line `line` keeps its place in that line's text. */
  const follow = (offset: number, line: number): number => {
    const k = line - first;
    return startOf(next, k) + Math.max(0, offset - startOf(lines, k) + next[k]!.length - lines[k]!.length);
  };
  return { edit: { start: from, end: from + lines.join('\n').length, inserted: next.join('\n') }, start: follow(start, first), end: follow(end, last) };
}
