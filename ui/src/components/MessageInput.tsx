// The message box's text: an editable element that shows `inline code` and fenced blocks in code
// style as the user types (@kestrel/server/code-spans). It is `contenteditable="plaintext-only"`,
// not a <textarea>: a textarea draws all its text in one font, so code drawn in monospace on a layer
// under it could never line up with its caret and wrapping. Here the styled text is the text being
// edited, so caret, selection, wrapping and scrolling are the browser's own. The text is exactly
// what was typed (messageInputDom.ts); the browser edits it natively and each change is drawn
// again, one line at a time. Because drawing replaces what the browser's undo remembers, undo and
// redo are kept here (@kestrel/server/edit-history), and line breaks and pasted text are put in by
// hand so they stay plain characters. Code blocks are coloured by language after each draw, around
// the same characters (highlight/boxColours.ts).
import { forwardRef, useEffect, useImperativeHandle, useRef, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react';
import { groupOf, newHistory, record, redo, undo, type EditGroup, type EditHistory, type Snapshot } from '@kestrel/server/edit-history';
import { applyChange, arrowChange, deleteChange, diffEdit, lineBreakChange, tabChange, type Change } from '@kestrel/server/draft-edit';
import { visibleOffset, wholeSelection } from '@kestrel/server/fence-blocks';
import { focusAtEnd, offsetOf, paint, pastMarker, readText, revealCaret, selectRange, selectionIn } from './messageInputDom.ts';
import { useBoxColours } from '../highlight/useBoxColours.ts';

interface Props {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  /** Files pasted in (attachments); when it handles the paste, text is not pasted. */
  onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
  placeholder: string;
  label: string;
  disabled?: boolean;
}

export interface MessageInputHandle {
  /** Focus the box with the caret at the end. */
  focus: () => void;
}

type Drawn = ReturnType<typeof paint>;

/** `text` with the caret at its end, or at the end of its code when it ends with a code block. */
const endOf = (text: string): Snapshot => {
  const end = visibleOffset(text, text.length);
  return { text, start: end, end };
};

export const MessageInput = forwardRef<MessageInputHandle, Props>(function MessageInput({ value, onChange, onKeyDown, onPaste, placeholder, label, disabled }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const drawn = useRef<Drawn>([]);
  const text = useRef(value);
  const history = useRef<EditHistory>(newHistory(endOf(value)));
  const composing = useRef(false);
  const change = useRef(onChange);
  change.current = onChange;
  // Code blocks' syntax colours, put on after each draw (highlight/boxColours.ts).
  const colour = useBoxColours(box, text, drawn, composing);

  useImperativeHandle(ref, () => ({ focus: () => focusAtEnd(box.current) }), []);

  /** Draw `next` and put the selection back where it belongs. */
  const draw = (next: string, sel: { start: number; end: number; backward?: boolean } | null) => {
    const el = box.current!;
    drawn.current = paint(el, next, drawn.current, sel?.start);
    text.current = next;
    el.classList.toggle('is-empty', next.length === 0);
    colour();
    if (!sel || document.activeElement !== el) return;
    selectRange(el, sel.start, sel.end, sel.backward);
    revealCaret(el);
  };

  /** The text became `next` by an edit of `group`: remember it, draw it, tell the owner. */
  const commit = (next: string, sel: Snapshot | null, group: EditGroup) => {
    const at = sel ?? endOf(next);
    const before = text.current;
    history.current = record(history.current, { text: next, start: at.start, end: at.end }, group);
    draw(next, at);
    if (next !== before) change.current(next);
  };

  // First draw, and text put in from outside (a reply picked in the conversation, the box cleared after sending).
  useEffect(() => {
    if (!box.current) return;
    if (drawn.current.length > 0 && value === text.current) return;
    const outside = drawn.current.length > 0;
    if (outside) history.current = record(history.current, endOf(value), null);
    draw(value, endOf(value));
  }, [value]);

  /** Make `change` with its automatic parts (@kestrel/server/draft-edit): one step of history. */
  const apply = (change: Change, group: EditGroup) => {
    const next = applyChange(text.current, change);
    commit(next.text, next, group);
  };

  /** Replace characters `start`..`end` with `inserted`, and put the caret after it. */
  const replace = (start: number, end: number, inserted: string, group: EditGroup) => apply({ edits: [{ start, end, inserted }] }, group);

  /** The selection as the draft's offsets (Select All takes in hidden fence lines), or null when it is not in the box. */
  const current = () => {
    const sel = selectionIn(box.current!);
    return sel && { ...sel, ...wholeSelection(text.current, sel.start, sel.end) };
  };

  /** The selection, or the end of the text when the box has none. */
  const selection = () => current() ?? endOf(text.current);

  /** Replace the selection with `inserted` (pasted text). */
  const insert = (inserted: string) => {
    const sel = selection();
    replace(sel.start, sel.end, inserted, null);
  };

  /**
   * What the browser is about to change, as character offsets. It does not always say (deleting
   * forward across a line break): then a deletion from a caret takes the character beside it,
   * always for a single character and for a word or line only when that character is a line break.
   */
  const targetOf = (native: InputEvent): { start: number; end: number } | null => {
    const el = box.current!;
    const range = native.getTargetRanges()[0];
    if (range) return { start: offsetOf(el, range.startContainer, range.startOffset), end: offsetOf(el, range.endContainer, range.endOffset) };
    const sel = selectionIn(el);
    if (!sel || sel.start !== sel.end || !native.inputType.startsWith('delete')) return null;
    const forward = native.inputType.endsWith('Forward');
    const side = forward ? text.current.slice(sel.start, sel.start + 2) : text.current.slice(Math.max(0, sel.start - 2), sel.start);
    const char = (forward ? [...side][0] : [...side].at(-1)) ?? '';
    const single = native.inputType === 'deleteContentForward' || native.inputType === 'deleteContentBackward';
    if (!char || (!single && char !== '\n')) return null;
    return forward ? { start: sel.start, end: sel.start + char.length } : { start: sel.start - char.length, end: sel.start };
  };

  const step = (to: EditHistory | null) => {
    if (!to) return;
    history.current = to;
    draw(to.present.text, to.present);
    change.current(to.present.text);
  };

  /**
   * While an input method composes (macOS inline predictions too) the box is not drawn again, which
   * would end the composition, but the text is still taken: the owner's draft is always what the box
   * holds, so text deleted mid-composition is never kept and brought back later.
   */
  const follow = (next: string) => {
    if (next === text.current) return;
    text.current = next;
    box.current!.classList.toggle('is-empty', next.length === 0);
    change.current(next);
  };

  const onInput = (event: FormEvent<HTMLDivElement>) => {
    const el = box.current!;
    const next = readText(el);
    if (composing.current) return follow(next);
    const native = event.nativeEvent as InputEvent;
    const group = groupOf(native.inputType ?? '', native.data ?? null);
    const sel = selectionIn(el);
    if (!sel) return commit(next, null, group);
    // What the browser typed, with its automatic parts (a number put in order as its space is typed).
    apply({ edits: [diffEdit(text.current, next, sel.end)], start: sel.start, end: sel.end }, group);
  };

  /** Leaving the box: whatever the browser did, the text kept is the text shown. */
  const settle = () => {
    composing.current = false;
    const next = readText(box.current!);
    if (next !== text.current) commit(next, null, null);
  };

  // React's onBeforeInput is not the browser's beforeinput (it has no inputType): listen to the real one.
  const onBeforeInput = (native: InputEvent) => {
    const type = native.inputType;
    // A composition's own changes cannot be cancelled: the browser makes them and they are read back.
    if (native.isComposing || composing.current) return;
    if (type === 'historyUndo' || type === 'historyRedo') {
      native.preventDefault();
      step(type === 'historyUndo' ? undo(history.current) : redo(history.current));
    } else if (type === 'insertParagraph' || type === 'insertLineBreak') {
      native.preventDefault();
      // A line break makes or leaves a code block, continues or ends a list (@kestrel/server/draft-edit).
      const sel = selection();
      apply(lineBreakChange(text.current, sel.start, sel.end), null);
    } else if (type.startsWith('delete') && type !== 'deleteByDrag') deleteHere(native);
    else if (type === 'insertText' || type === 'insertReplacementText') typeHere(native);
  };

  /**
   * The browser's own deleting merges and splits the line blocks and can drop a line break with
   * them; the same change made to the text is exact. Next to a code block's hidden fence line a
   * delete has rules of its own (@kestrel/server/fence-edits). (Moving text by dragging is left to
   * the browser: the drop goes where it already worked out, and the result is read back.)
   */
  const deleteHere = (native: InputEvent) => {
    const type = native.inputType;
    const sel = selection();
    const group = groupOf(type, null);
    if (sel.start !== sel.end) {
      native.preventDefault();
      return replace(sel.start, sel.end, '', group);
    }
    const edge = type.startsWith('deleteContent') ? deleteChange(text.current, sel.start, sel.end, type === 'deleteContentForward') : null;
    const target = edge ? null : targetOf(native);
    if (!edge && !target) return;
    native.preventDefault();
    if (edge) apply(edge, null);
    else replace(target!.start, target!.end, '', group);
  };

  /**
   * Text typed over a selection, or on an empty line, is put in here; elsewhere the browser types
   * it and it is read back. An empty line's only character is its line break, which the browser's
   * own typing can drop when a hidden fence line is beside it.
   */
  const typeHere = (native: InputEvent) => {
    const sel = selection();
    const at = sel.start;
    const emptyLine = (at === 0 || text.current[at - 1] === '\n') && (at === text.current.length || text.current[at] === '\n');
    // A spelling correction names the word it replaces, which is not the selection.
    const range = native.inputType === 'insertReplacementText' ? targetOf(native) : sel.start !== sel.end || emptyLine ? sel : null;
    if (!range) return;
    native.preventDefault();
    replace(range.start, range.end, native.data ?? native.dataTransfer?.getData('text/plain') ?? '', groupOf(native.inputType, native.data ?? null));
  };
  const beforeInput = useRef(onBeforeInput);
  beforeInput.current = onBeforeInput;
  useEffect(() => {
    const el = box.current!;
    const listener = (event: InputEvent) => beforeInput.current(event);
    el.addEventListener('beforeinput', listener);
    return () => el.removeEventListener('beforeinput', listener);
  }, []);

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (mod && !event.altKey && (key === 'z' || (key === 'y' && event.ctrlKey))) {
      event.preventDefault();
      step(key === 'z' && !event.shiftKey ? undo(history.current) : redo(history.current));
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !mod && !event.altKey && !event.shiftKey && !event.nativeEvent.isComposing) {
      // The way out of a code block that ends (or starts) the draft: a line after (or before) it.
      const sel = current();
      const change = sel && sel.start === sel.end ? arrowChange(text.current, sel.start, event.key === 'ArrowDown') : null;
      if (!change) return;
      event.preventDefault();
      apply(change, null);
    } else if (((event.key === 'ArrowRight' && event.metaKey) || event.key === 'End') && !event.altKey && !event.ctrlKey) {
      // The browser moves the caret; from a list item's number it only gets to the end of the
      // number's column, so it is carried on to the end of the line once the browser has moved it.
      const extend = event.shiftKey;
      requestAnimationFrame(() => box.current && pastMarker(box.current, extend));
    } else if (event.key === 'Tab' && !mod && !event.altKey && !event.nativeEvent.isComposing) {
      // Tab nests a list item and Shift Tab un-nests it; anywhere else Tab leaves the box as usual.
      const sel = current();
      const change = sel && tabChange(text.current, sel.start, sel.end, event.shiftKey);
      if (!change) return;
      event.preventDefault();
      apply(change, null);
    }
  };

  /**
   * Copy and cut take the draft's own characters: the browser would leave out the hidden fence
   * lines of a code block (it copies what is laid out), and the agent's markdown needs them.
   */
  const copy = (event: ClipboardEvent<HTMLDivElement>, cut: boolean) => {
    const sel = current();
    if (!sel || sel.start === sel.end) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', text.current.slice(sel.start, sel.end));
    if (cut) replace(sel.start, sel.end, '', null);
  };

  const paste = (event: ClipboardEvent<HTMLDivElement>) => {
    onPaste?.(event);
    if (event.defaultPrevented) return;
    event.preventDefault();
    insert(event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n'));
  };

  return (
    <div
      ref={box}
      className="composer-input message-input"
      role="textbox"
      aria-multiline="true"
      aria-label={label}
      aria-placeholder={placeholder}
      aria-disabled={disabled || undefined}
      data-placeholder={placeholder}
      contentEditable={disabled ? false : 'plaintext-only'}
      spellCheck
      suppressContentEditableWarning
      tabIndex={disabled ? -1 : 0}
      onInput={onInput}
      onKeyDown={keyDown}
      onPaste={paste}
      onCopy={(event) => copy(event, false)}
      onCut={(event) => copy(event, true)}
      onBlur={settle}
      onCompositionStart={() => void (composing.current = true)}
      onCompositionEnd={(event) => {
        composing.current = false;
        onInput(event as unknown as FormEvent<HTMLDivElement>);
      }}
    />
  );
});
