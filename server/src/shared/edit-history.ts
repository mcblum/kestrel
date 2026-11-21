// Undo and redo for a text box that draws its own text (the message box): what it held, and where
// the selection was, after each change. Typing one word is one step, as in a native text box: a
// letter typed right after a letter joins the step before it, a space or line break starts a new
// word, a run of deletions is one step, and moving the caret ends the step. Anything else (a paste,
// a cut, text put in from outside) is a step of its own. Grouping goes by what was done, never by time. Pure.

export interface Snapshot {
  text: string;
  start: number;
  end: number;
}

/** How a change joins the steps before it. */
export type EditGroup = 'type' | 'word' | 'delete' | null;

export interface EditHistory {
  past: Snapshot[];
  present: Snapshot;
  future: Snapshot[];
  /** The group the present step belongs to: a change in the same group joins it. */
  group: EditGroup;
}

const MAX_STEPS = 500;

export const newHistory = (present: Snapshot): EditHistory => ({ past: [], present, future: [], group: null });

/** The text changed to `next`; `group` says whether it joins the present step. */
export function record(history: EditHistory, next: Snapshot, group: EditGroup): EditHistory {
  if (next.text === history.present.text) return { ...history, present: next };
  if (group !== null && group !== 'word' && group === history.group && followsOn(history.present, next)) return { ...history, present: next, future: [] };
  const past = [...history.past, history.present].slice(-MAX_STEPS);
  // A word break starts a step that the letters after it join.
  return { past, present: next, future: [], group: group === 'word' ? 'type' : group };
}

/** The change was made where the caret was: it moved only by what was typed or deleted (or stayed, deleting forward). */
function followsOn(present: Snapshot, next: Snapshot): boolean {
  const delta = next.text.length - present.text.length;
  return next.end === present.end + delta || (delta < 0 && next.end === present.end);
}

/** One step back, or null when there is none. */
export function undo(history: EditHistory): EditHistory | null {
  const previous = history.past.at(-1);
  if (!previous) return null;
  return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future], group: null };
}

/** One step forward again, or null when there is none. */
export function redo(history: EditHistory): EditHistory | null {
  const next = history.future[0];
  if (!next) return null;
  return { past: [...history.past, history.present], present: next, future: history.future.slice(1), group: null };
}

/** The group of a browser input event (`InputEvent.inputType` and its data). */
export function groupOf(inputType: string, data: string | null): EditGroup {
  if (inputType === 'insertText') return data && /^\S$/u.test(data) ? 'type' : 'word';
  if (inputType === 'deleteContentBackward' || inputType === 'deleteContentForward') return 'delete';
  return null;
}
