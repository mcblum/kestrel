import { describe, expect, it } from 'vitest';
import { parentHears, turnReports } from './turn-reports.ts';

describe('who is told that a turn ended', () => {
  it('tells each role when they are different sessions', () => {
    expect(turnReports({ askers: ['a'], parent: 'p', waiters: ['w'] })).toEqual([
      { to: 'a', as: 'asker' },
      { to: 'p', as: 'parent' },
      { to: 'w', as: 'waiter' },
    ]);
  });

  it('an asker that is also the delegate parent is told once, as the asker', () => {
    expect(turnReports({ askers: ['p'], parent: 'p', waiters: [] })).toEqual([{ to: 'p', as: 'asker' }]);
  });

  it('a waiter that is also the delegate parent is told once, as the parent', () => {
    expect(turnReports({ askers: [], parent: 'p', waiters: ['p'] })).toEqual([{ to: 'p', as: 'parent' }]);
  });

  it('an asker that is also a waiter is told once, as the asker', () => {
    expect(turnReports({ askers: ['a'], parent: null, waiters: ['a', 'w'] })).toEqual([
      { to: 'a', as: 'asker' },
      { to: 'w', as: 'waiter' },
    ]);
  });

  it('a parent that does not hear this turn is still told of a wait it declared', () => {
    expect(turnReports({ askers: [], parent: null, waiters: ['p'] })).toEqual([{ to: 'p', as: 'waiter' }]);
  });

  it('a turn the user started in the child does not report to its parent; any other turn does', () => {
    expect(parentHears({ byUser: true })).toBe(false);
    expect(parentHears({ byUser: false })).toBe(true);
  });
});
