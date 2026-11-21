import { describe, expect, it } from 'vitest';
import { rememberScroll, scrollFor, tabForKey } from './local-tabs.ts';

const tabs = ['sessions', 'settings'] as const;

describe('local tab keys', () => {
  it('moves with the arrows and wraps around', () => {
    expect(tabForKey(tabs, 'sessions', 'ArrowRight')).toBe('settings');
    expect(tabForKey(tabs, 'settings', 'ArrowRight')).toBe('sessions');
    expect(tabForKey(tabs, 'sessions', 'ArrowLeft')).toBe('settings');
  });

  it('goes to the ends with Home and End and ignores other keys', () => {
    expect(tabForKey(tabs, 'settings', 'Home')).toBe('sessions');
    expect(tabForKey(tabs, 'sessions', 'End')).toBe('settings');
    expect(tabForKey(tabs, 'sessions', 'Enter')).toBeNull();
  });
});

describe('scroll kept per local tab', () => {
  it('remembers where each tab was left and starts a new one at the top', () => {
    let memory = rememberScroll({}, 'sessions', 420.4);
    expect(scrollFor(memory, 'settings')).toBe(0);
    memory = rememberScroll(memory, 'settings', 80);
    expect(scrollFor(memory, 'sessions')).toBe(420);
    expect(memory).toEqual({ sessions: 420, settings: 80 });
  });

  it('keeps the same memory when nothing moved and never changes the one it was given', () => {
    const memory = { sessions: 10 };
    expect(rememberScroll(memory, 'sessions', 10)).toBe(memory);
    rememberScroll(memory, 'sessions', 99);
    expect(memory).toEqual({ sessions: 10 });
    expect(rememberScroll({}, 'x', -5)).toEqual({ x: 0 });
  });
});
