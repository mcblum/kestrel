import { describe, expect, test } from 'vitest';
import { browsersToClose, LIVE_BROWSER_CAP, type LiveBrowser } from './browser-cap.ts';

const page = (key: string, lastUsed: number, extra: Partial<LiveBrowser> = {}): LiveBrowser => ({ key, lastUsed, onScreen: false, busy: false, ...extra });

describe('browsersToClose', () => {
  test('closes nothing at or under the cap', () => {
    expect(browsersToClose([page('a', 1), page('b', 2)], 2)).toEqual([]);
    expect(browsersToClose([], 2)).toEqual([]);
  });

  test('closes the ones used longest ago, as many as are over', () => {
    expect(browsersToClose([page('new', 9), page('old', 1), page('mid', 5)], 1)).toEqual(['old', 'mid']);
  });

  test('never closes the page on screen, even when it is the oldest', () => {
    expect(browsersToClose([page('shown', 1, { onScreen: true }), page('b', 2), page('c', 3)], 2)).toEqual(['b']);
  });

  test('never closes a page an agent is using', () => {
    expect(browsersToClose([page('busy', 1, { busy: true }), page('b', 2), page('c', 3)], 2)).toEqual(['b']);
  });

  test('closes fewer when the rest cannot be closed', () => {
    expect(browsersToClose([page('a', 1, { onScreen: true }), page('b', 2, { busy: true }), page('c', 3)], 1)).toEqual(['c']);
  });

  test('defaults to the window cap', () => {
    const many = Array.from({ length: LIVE_BROWSER_CAP + 2 }, (_, i) => page(`p${i}`, i));
    expect(browsersToClose(many)).toEqual(['p0', 'p1']);
  });
});
