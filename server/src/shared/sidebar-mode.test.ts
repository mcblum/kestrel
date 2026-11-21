// When the sidebar turns into the icon rail, and which sessions the rail lists.
import { describe, expect, it } from 'vitest';
import { NO_PANES, PANE_WIDTH, SIM_WIDTH } from './pane-layout.ts';
import { MAIN_AREA_MIN, RAIL_MAX_SESSIONS, panesMinWidth, railSessions, sidebarMode, type RailSession } from './sidebar-mode.ts';

describe('sidebarMode', () => {
  const sidebarWidth = 252;
  const fits = sidebarWidth + MAIN_AREA_MIN;

  it('draws the full sidebar while the window fits it beside the main content', () => {
    expect(sidebarMode({ windowWidth: fits, sidebarWidth, hidden: false })).toBe('full');
    expect(sidebarMode({ windowWidth: 1600, sidebarWidth, hidden: false })).toBe('full');
  });
  it('draws the rail once the window is narrower than that', () => {
    expect(sidebarMode({ windowWidth: fits - 1, sidebarWidth, hidden: false })).toBe('rail');
    expect(sidebarMode({ windowWidth: 300, sidebarWidth, hidden: false })).toBe('rail');
  });
  it('counts the open side panes', () => {
    const panesWidth = PANE_WIDTH.min * 2;
    expect(sidebarMode({ windowWidth: fits + panesWidth, sidebarWidth, hidden: false, panesWidth })).toBe('full');
    expect(sidebarMode({ windowWidth: fits + panesWidth - 1, sidebarWidth, hidden: false, panesWidth })).toBe('rail');
  });
  it('takes a wider sidebar into account', () => {
    expect(sidebarMode({ windowWidth: 900, sidebarWidth: 520, hidden: false })).toBe('rail');
    expect(sidebarMode({ windowWidth: 900, sidebarWidth: 200, hidden: false })).toBe('full');
  });
  it('keeps a hidden sidebar hidden at any width', () => {
    expect(sidebarMode({ windowWidth: 300, sidebarWidth, hidden: true })).toBe('hidden');
    expect(sidebarMode({ windowWidth: 1600, sidebarWidth, hidden: true })).toBe('hidden');
  });
});

describe('panesMinWidth', () => {
  it('is nothing with no pane open, and leaves out Context, which floats', () => {
    expect(panesMinWidth(NO_PANES)).toBe(0);
    expect(panesMinWidth({ ...NO_PANES, context: true })).toBe(0);
  });
  it('counts the tools column once however many panes stack in it', () => {
    expect(panesMinWidth({ ...NO_PANES, files: true })).toBe(PANE_WIDTH.min);
    expect(panesMinWidth({ ...NO_PANES, files: true, terminal: true, browser: true, agent: true })).toBe(PANE_WIDTH.min);
  });
  it('counts Commands as the tools column, alone or with the others', () => {
    expect(panesMinWidth({ ...NO_PANES, commands: true })).toBe(PANE_WIDTH.min);
    expect(panesMinWidth({ ...NO_PANES, commands: true, files: true })).toBe(PANE_WIDTH.min);
  });
  it('adds Changes and the Simulator at their minimums', () => {
    expect(panesMinWidth({ ...NO_PANES, changes: true, terminal: true, simulator: true })).toBe(PANE_WIDTH.min * 2 + SIM_WIDTH.min);
  });
});

describe('railSessions', () => {
  const s = (id: string, dot: RailSession['dot'] = 'none'): RailSession => ({ id, dot });

  it('lists the pinned sessions, then the unpinned ones waiting for an answer', () => {
    const all = [s('a', 'unread'), s('b', 'needs-you'), s('c', 'working'), s('d', 'needs-you')];
    expect(railSessions([s('c', 'working'), s('d', 'needs-you')], all).map((x) => x.id)).toEqual(['c', 'd', 'b']);
  });
  it('leaves out sessions that are neither pinned nor waiting', () => {
    expect(railSessions([], [s('a', 'unread'), s('b', 'working'), s('c')])).toEqual([]);
  });
  it('lists each session once and stops at the limit', () => {
    const many = Array.from({ length: RAIL_MAX_SESSIONS + 5 }, (_, i) => s(`n${i}`, 'needs-you'));
    expect(railSessions([s('p'), s('p')], many)).toHaveLength(RAIL_MAX_SESSIONS);
    expect(railSessions([s('p'), s('p')], many)[1]!.id).toBe('n0');
    expect(railSessions([s('p')], many, 0)).toEqual([]);
  });
});
