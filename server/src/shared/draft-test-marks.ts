// For the message box's tests: a draft written with its caret as `|` (or its selection as
// `[`..`]`), and the keys the box handles, made through the same functions the box calls.
import { applyChange, arrowChange, deleteChange, lineBreakChange, tabChange, type Change, type DraftState } from './draft-edit.ts';

export function parse(marked: string): DraftState {
  if (marked.includes('|')) {
    const at = marked.indexOf('|');
    return { text: marked.replace('|', ''), start: at, end: at };
  }
  const start = marked.indexOf('[');
  const end = marked.indexOf(']') - 1;
  return { text: marked.replace('[', '').replace(']', ''), start, end };
}

export function show(state: DraftState): string {
  const { text, start, end } = state;
  if (start === end) return `${text.slice(0, start)}|${text.slice(start)}`;
  return `${text.slice(0, start)}[${text.slice(start, end)}]${text.slice(end)}`;
}

const step = (state: DraftState, change: Change) => applyChange(state.text, change);

/** Type `typed` over the selection one key at a time; `\n` is Shift Return. */
export function type(marked: string, typed: string): string {
  let state = parse(marked);
  for (const char of typed) {
    state = step(state, char === '\n' ? lineBreakChange(state.text, state.start, state.end) : { edits: [{ start: state.start, end: state.end, inserted: char }] });
  }
  return show(state);
}

/** Backspace (or Delete with `forward`) as the box makes it. */
export function backspace(marked: string, forward = false): string {
  const s = parse(marked);
  const edge = deleteChange(s.text, s.start, s.end, forward);
  if (edge) return show(step(s, edge));
  const start = s.start === s.end && !forward ? s.start - 1 : s.start;
  const end = s.start === s.end && forward ? s.end + 1 : s.end;
  return show(step(s, { edits: [{ start, end, inserted: '' }] }));
}

/** Paste `pasted` over the selection. */
export function paste(marked: string, pasted: string): string {
  const s = parse(marked);
  return show(step(s, { edits: [{ start: s.start, end: s.end, inserted: pasted }] }));
}

/** Tab, or Shift Tab with `outdent`; null when the box leaves it to the browser. */
export function tab(marked: string, outdent = false): string | null {
  const s = parse(marked);
  const change = tabChange(s.text, s.start, s.end, outdent);
  return change && show(step(s, change));
}

/** Arrow Down (or Up); null when the box leaves it to the browser. */
export function arrow(marked: string, down: boolean): string | null {
  const s = parse(marked);
  const change = arrowChange(s.text, s.start, down);
  return change && show(step(s, change));
}
