// The DOM side of the message box (MessageInput.tsx): drawing the text as styled lines, reading it
// back, and moving the selection by character offset. The box holds the draft's text exactly: one
// block per line, each line's text followed by its line break. An empty last line holds a
// placeholder <br> that is not text. The fence lines of a code block (@kestrel/server/fence-blocks)
// are blocks like any other but drawn with `display: none`: their characters are still in the DOM,
// so reading the text and turning DOM positions into offsets count them exactly, while the browser
// lays nothing out for them, so it never puts the caret there and a screen reader does not read them.
import type { CodePiece } from '@kestrel/server/code-spans';
import { boxLines, visibleOffset, type BoxLine } from '@kestrel/server/fence-blocks';
import { listMarker, markerWidthEm } from '@kestrel/server/list-lines';

const PLACEHOLDER = 'data-ph';

/** One drawn line: its look and text (line break included), so an unchanged line keeps its element. */
interface Painted {
  key: string;
  el: HTMLElement;
}

/** How a line looks: its classes, and a code block's language label. Never holds "|", which ends a key's look. */
function lineLook(line: BoxLine): string {
  // A list item (shared/list-lines.ts): its marker in a column, its wrapped lines under its text.
  if (line.kind === 'text') return listMarker(line.text) ? 'mi-line mi-list' : 'mi-line';
  if (line.kind === 'hidden') return 'mi-line mi-fence-hidden';
  // A fence line in view (a fence left open, or one being typed) is drawn quietly.
  const mark = line.kind === 'fence' ? ' mi-fence-mark' : '';
  const label = line.lang ? `#${line.lang}` : '';
  return `mi-line mi-fence${mark}${line.first ? ' mi-fence-first' : ''}${line.last ? ' mi-fence-last' : ''}${label}`;
}

/** Inline code with its backticks: they are the text, so they stay, drawn quietly. */
function inlineCode(piece: CodePiece): HTMLElement {
  const code = document.createElement('code');
  const ticks = piece.ticks ?? 0;
  const tick = (text: string) => {
    const span = document.createElement('span');
    span.className = 'mi-tick';
    span.textContent = text;
    return span;
  };
  code.append(tick(piece.text.slice(0, ticks)), piece.text.slice(ticks, piece.text.length - ticks), tick(piece.text.slice(piece.text.length - ticks)));
  return code;
}

/** A text line's pieces: the list marker in its box, plain text, inline code. */
function appendPieces(el: HTMLElement, line: BoxLine, brk: boolean): void {
  // The marker of a list item is the same characters, in a box of their own.
  const marker = listMarker(line.text);
  if (marker) el.style.setProperty('--mi-marker', `${markerWidthEm(marker)}em`);
  line.pieces.forEach((piece, i) => {
    let text = piece.text + (brk && i === line.pieces.length - 1 ? '\n' : '');
    // The marker is always at the start of the first piece: a backtick cannot be part of one.
    if (marker && i === 0 && piece.kind === 'text') {
      const box = document.createElement('span');
      box.className = marker.ordered ? 'mi-marker' : 'mi-marker mi-bullet';
      box.textContent = piece.text.slice(0, marker.length);
      el.append(box);
      text = text.slice(marker.length);
    }
    if (piece.kind === 'text') return text && el.append(text);
    el.append(inlineCode(piece));
    if (text !== piece.text) el.append('\n');
  });
}

function lineElement(line: BoxLine, look: string, brk: boolean): HTMLElement {
  const el = document.createElement('span');
  // The label comes after the first "#" (a language may hold one: "c#").
  const label = look.indexOf('#');
  el.className = label === -1 ? look : look.slice(0, label);
  if (label !== -1) el.dataset.lang = look.slice(label + 1);
  if (line.kind === 'text') appendPieces(el, line, brk);
  else el.append(line.text + (brk ? '\n' : ''));
  if (!brk && !line.text) {
    const br = document.createElement('br');
    br.setAttribute(PLACEHOLDER, '');
    el.append(br);
  }
  return el;
}

/**
 * Draw `text` into `root`, reusing the elements of lines that did not change (the lines before and
 * after the edit), so typing in a long draft touches one line. `caret` keeps a fence line being
 * typed in view. Returns what is now drawn.
 */
export function paint(root: HTMLElement, text: string, before: readonly Painted[], caret = -1): Painted[] {
  const lines = boxLines(text, caret);
  const keys = lines.map((line, i) => `${lineLook(line)}|${line.text}${i < lines.length - 1 ? '\n' : ''}`);
  const intact = (p: Painted) => p.el.parentNode === root && p.el.textContent === p.key.slice(p.key.indexOf('|') + 1);
  let head = 0;
  while (head < keys.length && head < before.length && before[head]!.key === keys[head] && intact(before[head]!)) head++;
  let tail = 0;
  while (tail < keys.length - head && tail < before.length - head && before[before.length - 1 - tail]!.key === keys[keys.length - 1 - tail] && intact(before[before.length - 1 - tail]!)) tail++;
  const replaced = before.slice(head, before.length - tail);
  const middle = keys.slice(head, keys.length - tail).map((key, j) => {
    const i = head + j;
    const el = lineElement(lines[i]!, key.slice(0, key.indexOf('|')), i < lines.length - 1);
    // A line the browser has already edited into exactly what would be drawn keeps its element:
    // replacing it would make the spell checker see the word being typed as new text and mark it.
    const own = replaced[j]?.el;
    return { key, el: own && own.parentNode === root && own.isEqualNode(el) ? own : el };
  });
  const next = [...before.slice(0, head), ...middle, ...before.slice(before.length - tail)];
  const sameChildren = root.childNodes.length === before.length && before.every((p, i) => root.childNodes[i] === p.el);
  if (!sameChildren) root.replaceChildren(...next.map((p) => p.el));
  else {
    const kept = new Set(middle.map((p) => p.el));
    replaced.forEach((p) => kept.has(p.el) || p.el.remove());
    // Kept elements are already in place and in order: insert only the new ones, never move a kept one.
    let cursor: ChildNode | null = head > 0 ? before[head - 1]!.el.nextSibling : root.firstChild;
    for (const p of middle) {
      if (p.el === cursor) cursor = cursor.nextSibling;
      else root.insertBefore(p.el, cursor);
    }
  }
  return next;
}

/** The text a node holds, by the same rules the box is drawn with. */
export function readText(node: Node): string {
  let out = '';
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) out += (n as Text).data;
    else if (n.nodeName === 'BR') {
      // Ours holds an empty last line open; one the browser leaves at the end of a block (after
      // deleting everything in it) draws nothing either. Only a <br> with text after it is a break.
      if (!(n as Element).hasAttribute(PLACEHOLDER) && n.nextSibling) out += '\n';
    } else {
      // A block the browser made itself (a paste or drop it handled) starts a new line.
      if ((n.nodeName === 'DIV' || n.nodeName === 'P') && out && !out.endsWith('\n')) out += '\n';
      n.childNodes.forEach(walk);
    }
  };
  node.childNodes.forEach(walk);
  return out.replace(/\r\n?/g, '\n');
}

/** The character offset of a DOM position inside `root`. */
export function offsetOf(root: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.setStart(root, 0);
  range.setEnd(node, offset);
  return readText(range.cloneContents()).length;
}

/** The selection as character offsets, or null when it is not in `root`. */
export function selectionIn(root: HTMLElement): { start: number; end: number; backward: boolean } | null {
  const sel = root.ownerDocument.getSelection();
  if (!sel || sel.rangeCount === 0 || !root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return null;
  const anchor = offsetOf(root, sel.anchorNode!, sel.anchorOffset);
  const focus = offsetOf(root, sel.focusNode!, sel.focusOffset);
  return { start: Math.min(anchor, focus), end: Math.max(anchor, focus), backward: focus < anchor };
}

/** The DOM position just before character `offset` (at the very end, after the last one). */
function positionAt(root: HTMLElement, offset: number): { node: Node; offset: number } {
  let left = offset;
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (left < n.data.length) return { node: n, offset: left };
    left -= n.data.length;
    last = n;
  }
  // The end: an empty last line (its placeholder), else after the last character.
  const lastLine = root.lastElementChild;
  if (lastLine?.querySelector(`br[${PLACEHOLDER}]`)) return { node: lastLine, offset: 0 };
  return last ? { node: last, offset: last.data.length } : { node: root, offset: 0 };
}

/** Put the selection at character offsets `start`..`end`. */
export function selectRange(root: HTMLElement, start: number, end = start, backward = false): void {
  const sel = root.ownerDocument.getSelection();
  if (!sel) return;
  const a = positionAt(root, backward ? end : start);
  const b = positionAt(root, backward ? start : end);
  sel.setBaseAndExtent(a.node, a.offset, b.node, b.offset);
}

/** Focus the box with the caret at the end of its text. */
/**
 * After "go to the end of the line" (Cmd Right, End): a caret left in a list item's marker column
 * is carried on to the end of the item's line. The marker is a box of its own, and the browser
 * stops at the end of that box and stays there. `extend` keeps the selection's other end (Shift).
 */
export function pastMarker(root: HTMLElement, extend: boolean): void {
  const sel = document.getSelection();
  const at = sel?.focusNode;
  if (!sel || !at) return;
  // In the marker, or at the very start of the item's text just after it: both are where the
  // browser leaves the caret, and from both it will not go further by itself.
  const before = at.nodeType === Node.TEXT_NODE && sel.focusOffset === 0 ? at.previousSibling : null;
  const inside = (at instanceof Element ? at : at.parentElement)?.closest('.mi-marker') ?? null;
  const marker = inside ?? (before instanceof Element && before.classList.contains('mi-marker') ? before : null);
  if (!marker || !root.contains(marker) || !marker.parentNode) return;
  // One character into the item's text: from the very start of it the browser still counts the
  // caret as at the marker's edge and does not move. An item with no text has nowhere further to go.
  const after = marker.nextSibling;
  if (after?.nodeType !== Node.TEXT_NODE || !after.textContent || after.textContent === '\n') return;
  if (extend) sel.extend(after, 1);
  else sel.collapse(after, 1);
  sel.modify(extend ? 'extend' : 'move', 'forward', 'lineboundary');
}

export function focusAtEnd(root: HTMLElement | null): void {
  if (!root) return;
  root.focus();
  const text = readText(root);
  selectRange(root, visibleOffset(text, text.length));
  revealCaret(root);
}

/** Scroll the box so the caret is in view (after text the box put in itself: a line break, a paste, an undo). */
export function revealCaret(root: HTMLElement): void {
  const sel = root.ownerDocument.getSelection();
  if (!sel || sel.rangeCount === 0 || !root.contains(sel.focusNode)) return;
  const range = document.createRange();
  range.setStart(sel.focusNode!, sel.focusOffset);
  const rect = range.getClientRects()[0] ?? (sel.focusNode instanceof Element ? sel.focusNode.getBoundingClientRect() : null);
  if (!rect) return;
  const box = root.getBoundingClientRect();
  if (rect.bottom > box.bottom) root.scrollTop += rect.bottom - box.bottom + 4;
  else if (rect.top < box.top) root.scrollTop -= box.top - rect.top + 4;
}
