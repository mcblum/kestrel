import { describe, expect, it } from 'vitest';
import { groupOf, newHistory, record, redo, undo, type EditGroup, type EditHistory } from './edit-history.ts';

const at = (text: string) => ({ text, start: text.length, end: text.length });
/** Type `text` one character at a time, as the browser reports it. */
const type = (h: EditHistory, text: string) => [...text].reduce((acc, ch) => record(acc, at(acc.present.text + ch), groupOf('insertText', ch)), h);

describe('undo in the message box', () => {
  it('takes back a word at a time', () => {
    let h = type(newHistory(at('')), 'hello world');
    h = undo(h)!;
    expect(h.present.text).toBe('hello');
    h = undo(h)!;
    expect(h.present.text).toBe('');
    expect(undo(h)).toBeNull();
  });

  it('redoes what was undone, and forgets it after a new change', () => {
    let h = type(newHistory(at('')), 'one two');
    h = undo(h)!;
    expect(redo(h)!.present.text).toBe('one two');
    h = record(h, at('one!'), null);
    expect(redo(h)).toBeNull();
  });

  it('makes a run of deletions one step, and a paste a step of its own', () => {
    let h = type(newHistory(at('')), 'abc');
    h = record(h, at('abcPASTED'), null);
    h = record(h, at('abcPASTE'), 'delete');
    h = record(h, at('abcPAST'), 'delete');
    expect(undo(h)!.present.text).toBe('abcPASTED');
    expect(undo(undo(h)!)!.present.text).toBe('abc');
  });

  it('makes a run of forward deletions one step too', () => {
    let h = record(newHistory({ text: 'abcd', start: 1, end: 1 }), { text: 'acd', start: 1, end: 1 }, 'delete');
    h = record(h, { text: 'ad', start: 1, end: 1 }, 'delete');
    expect(undo(h)!.present.text).toBe('abcd');
  });

  it('starts a new step when the caret moved between letters', () => {
    let h = type(newHistory(at('')), 'ab');
    h = record(h, { text: 'Xab', start: 1, end: 1 }, 'type'); // typed at the start
    expect(undo(h)!.present.text).toBe('ab');
  });

  it('keeps the selection with each step, and a selection change alone is no step', () => {
    let h = record(newHistory(at('')), { text: 'ab', start: 1, end: 2 }, null);
    h = record(h, { text: 'ab', start: 0, end: 0 }, null);
    expect(h.past).toHaveLength(1);
    expect(h.present).toEqual({ text: 'ab', start: 0, end: 0 });
  });

  it('keeps at most 500 steps', () => {
    let h = newHistory(at(''));
    for (let i = 0; i < 600; i++) h = record(h, at(String(i)), null);
    expect(h.past).toHaveLength(500);
  });
});

describe('the group of an input event', () => {
  it('tells letters, word breaks, deletions and everything else apart', () => {
    const cases: [string, string | null, EditGroup][] = [
      ['insertText', 'a', 'type'],
      ['insertText', ' ', 'word'],
      ['insertText', 'ab', 'word'],
      ['deleteContentBackward', null, 'delete'],
      ['insertFromPaste', null, null],
      ['deleteByCut', null, null],
    ];
    for (const [inputType, data, group] of cases) expect(groupOf(inputType, data)).toBe(group);
  });
});
