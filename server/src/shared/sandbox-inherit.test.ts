// The one rule for whether a session another session started may leave its sandbox without asking (issue 74).
import { describe, expect, it } from 'vitest';
import { inheritsOutside, leavesSandboxUnasked, offersInherit } from './sandbox-inherit.ts';

describe('leavesSandboxUnasked', () => {
  it('a session the user started is not asked in Auto or Bypass, and is in every other mode, whatever the switch', () => {
    for (const inherit of [true, false]) {
      expect(leavesSandboxUnasked(['auto'], inherit)).toBe(true);
      expect(leavesSandboxUnasked(['bypass'], inherit)).toBe(true);
      for (const mode of ['ask', 'edits', 'plan', 'readonly'] as const) expect(leavesSandboxUnasked([mode], inherit)).toBe(false);
    }
  });

  it('a child asks while the switch is off, whoever started it', () => {
    expect(leavesSandboxUnasked(['auto', 'auto'], false)).toBe(false);
    expect(leavesSandboxUnasked(['auto', 'bypass'], false)).toBe(false);
  });

  it('with the switch on, a child in Auto of a session that would not be asked is not asked', () => {
    expect(leavesSandboxUnasked(['auto', 'auto'], true)).toBe(true);
    // A Bypass parent's child runs in Auto (childPermission): it inherits.
    expect(leavesSandboxUnasked(['auto', 'bypass'], true)).toBe(true);
  });

  it('a child of a Manual session still asks, and so does a child that is not in Auto itself', () => {
    expect(leavesSandboxUnasked(['ask', 'ask'], true)).toBe(false);
    expect(leavesSandboxUnasked(['auto', 'ask'], true)).toBe(false);
    expect(leavesSandboxUnasked(['ask', 'auto'], true)).toBe(false);
    expect(leavesSandboxUnasked(['edits', 'auto'], true)).toBe(false);
  });

  it('inherits down a chain only while every session above it would not be asked', () => {
    expect(leavesSandboxUnasked(['auto', 'auto', 'auto'], true)).toBe(true);
    expect(leavesSandboxUnasked(['auto', 'auto', 'ask'], true)).toBe(false);
    expect(leavesSandboxUnasked(['auto', 'plan', 'auto'], true)).toBe(false);
  });

  it('asks when nothing is known of the session', () => {
    expect(leavesSandboxUnasked([], true)).toBe(false);
  });
});

describe('inheritsOutside and offersInherit', () => {
  it('only a child inherits: a session the user started is never said to', () => {
    expect(inheritsOutside(['auto'], true)).toBe(false);
    expect(inheritsOutside(['auto', 'auto'], true)).toBe(true);
    expect(inheritsOutside(['auto', 'auto'], false)).toBe(false);
  });

  it('the card offers the switch only while it is off and turning it on would let this child through', () => {
    expect(offersInherit(['auto', 'auto'], false)).toBe(true);
    expect(offersInherit(['auto', 'auto'], true)).toBe(false);
    expect(offersInherit(['auto', 'ask'], false)).toBe(false);
    expect(offersInherit(['ask', 'auto'], false)).toBe(false);
    expect(offersInherit(['auto'], false)).toBe(false);
  });
});
