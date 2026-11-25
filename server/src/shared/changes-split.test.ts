import { describe, expect, it } from 'vitest';
import { CHANGES_DIFF_MIN, CHANGES_LIST_HEIGHT, changesListDefault, changesListHeight, changesListMax, changesListTarget, clampChangesListHeight, dragChangesSplit } from './changes-split.ts';
import { sanitizeSidebar } from './sidebar.ts';

describe('the Changes pane split', () => {
  it('starts with the usual height, never more than a third of the pane', () => {
    expect(changesListDefault(1200)).toBe(CHANGES_LIST_HEIGHT.initial);
    expect(changesListDefault(450)).toBe(150);
    expect(changesListDefault(120)).toBe(CHANGES_LIST_HEIGHT.min);
    expect(changesListDefault(0)).toBe(CHANGES_LIST_HEIGHT.initial);
  });

  it('keeps the dragged height inside the pane, leaving the diff its minimum', () => {
    expect(changesListTarget(300, 900)).toBe(300);
    expect(changesListTarget(5000, 900)).toBe(900 - CHANGES_DIFF_MIN);
    expect(changesListTarget(10, 900)).toBe(CHANGES_LIST_HEIGHT.min);
    expect(changesListTarget(undefined, 900)).toBe(CHANGES_LIST_HEIGHT.initial);
    expect(changesListTarget(Number.NaN, 900)).toBe(CHANGES_LIST_HEIGHT.initial);
  });

  it('gives the list its minimum even in a pane too short for both', () => {
    expect(changesListMax(100)).toBe(CHANGES_LIST_HEIGHT.min);
    expect(changesListTarget(300, 100)).toBe(CHANGES_LIST_HEIGHT.min);
  });

  it('shrinks to a list shorter than where the bar stands, so no space is left above the diff', () => {
    expect(changesListHeight(300, 900, 74.5)).toBe(75);
    expect(changesListHeight(300, 900, 2000)).toBe(300);
    expect(changesListHeight(300, 900, 0)).toBe(300);
  });

  it('moves with a drag, within the limits', () => {
    expect(dragChangesSplit(200, 50, 900)).toBe(250);
    expect(dragChangesSplit(200, -500, 900)).toBe(CHANGES_LIST_HEIGHT.min);
    expect(dragChangesSplit(200, 5000, 900)).toBe(900 - CHANGES_DIFF_MIN);
    expect(dragChangesSplit(200, Number.NaN, 900)).toBe(200);
  });

  it('is stored as a whole number inside the limits', () => {
    expect(clampChangesListHeight(123.6)).toBe(124);
    expect(clampChangesListHeight(-5)).toBe(CHANGES_LIST_HEIGHT.min);
    expect(clampChangesListHeight(1e9)).toBe(CHANGES_LIST_HEIGHT.max);
  });

  it('is remembered with the other pane sizes, and odd values are dropped', () => {
    expect(sanitizeSidebar({ order: [], collapsed: [], changesListHeight: 260 }).changesListHeight).toBe(260);
    expect(sanitizeSidebar({ order: [], collapsed: [], changesListHeight: 1 }).changesListHeight).toBe(CHANGES_LIST_HEIGHT.min);
    expect(sanitizeSidebar({ order: [], collapsed: [], changesListHeight: 'tall' })).not.toHaveProperty('changesListHeight');
    expect(sanitizeSidebar({ order: [], collapsed: [] })).not.toHaveProperty('changesListHeight');
  });
});
