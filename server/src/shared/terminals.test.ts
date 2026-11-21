import { describe, expect, it } from 'vitest';
import { MAX_TERMINAL_TABS, moveTerminal, numberTitles, terminalMenuLabel, terminalStripMode } from './terminals.ts';

describe('the terminal strip', () => {
  it('shows tabs up to the limit, and one menu past it', () => {
    expect(MAX_TERMINAL_TABS).toBe(3);
    expect(terminalStripMode(0)).toBe('tabs');
    expect(terminalStripMode(3)).toBe('tabs');
    expect(terminalStripMode(4)).toBe('menu');
    expect(terminalStripMode(8)).toBe('menu');
  });

  it('labels the menu with the current terminal and its place', () => {
    const list = [{ id: 'a', title: 'zsh' }, { id: 'b', title: 'zsh 2' }, { id: 'c', title: 'dev server' }, { id: 'd', title: 'vim' }];
    expect(terminalMenuLabel(list, 'b')).toBe('zsh 2 · 2 of 4');
    expect(terminalMenuLabel(list, 'd')).toBe('vim · 4 of 4');
    expect(terminalMenuLabel(list, null)).toBe('4 terminals');
  });

  it('moves a tab before or after another, and ignores a stale drop', () => {
    expect(moveTerminal(['a', 'b', 'c'], 'c', 'a', false)).toEqual(['c', 'a', 'b']);
    expect(moveTerminal(['a', 'b', 'c'], 'a', 'c', true)).toEqual(['b', 'c', 'a']);
    expect(moveTerminal(['a', 'b', 'c'], 'a', 'a', true)).toEqual(['a', 'b', 'c']);
    expect(moveTerminal(['a', 'b'], 'x', 'a', false)).toEqual(['a', 'b']);
  });

  it('numbers repeated automatic titles in tab order', () => {
    expect(numberTitles([{ custom: null, program: 'zsh' }, { custom: 'mine', program: 'zsh' }, { custom: null, program: 'zsh' }])).toEqual(['zsh', 'mine', 'zsh 2']);
  });
});
