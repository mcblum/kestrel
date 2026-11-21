// Pass-through wrappers (wrappers.ts): a command put inside a known transparent proxy such as rtk
// is judged as the command inside it; the wrapper itself never widens the list.
import { describe, expect, it } from 'vitest';
import type { SandboxAllowEntry } from '../shared/sandbox-allow.ts';
import { commandInBounds, outsidePaths, type Bounds } from './match.ts';
import { commandOffer } from './offer.ts';
import { unwrapCommand } from './wrappers.ts';

const bounds: Bounds = { cwd: '/w/child', home: '/Users/me', folders: ['/w/child', '/repo/.git', '/tmp'] };
const entries: SandboxAllowEntry[] = [
  { kind: 'command', words: ['git', 'commit'] },
  { kind: 'command', words: ['gpg'] },
];
const allowed = (line: string) => commandInBounds(line, entries, bounds).allowed;

describe('a command inside a known wrapper', () => {
  it.each([
    'rtk git commit -m x',
    'rtk git commit -am d2',
    'rtk proxy git commit -m x',
    'rtk proxy rtk git commit -m x', // nested
    'rtk rtk git commit -m x', // nested
    'rtk git commit -m x && rtk gpg --list-keys',
    'git commit -m x; rtk proxy gpg --list-keys',
  ])('is judged as the command inside it: %j is covered', (line) => {
    expect(allowed(line)).toBe(true);
  });

  it.each([
    ['rtk proxy rm -rf ~', 'the raw form runs anything: judged as rm'],
    ['rtk git -c x=y commit', 'an option between git and its subcommand'],
    ['rtk sudo git commit', 'sudo inside the wrapper'],
    ['rtk env git commit', 'env inside the wrapper'],
    ['rtk git commit -m x && rm -rf ~', 'chained with an unlisted command'],
    ['rtk git commit; rtk proxy rm x', 'chained with an unlisted command through the raw form'],
    ['rtk gain', "the wrapper's own subcommand"],
    ['rtk proxy', 'the raw form with nothing in it'],
    ['rtk', 'the wrapper alone'],
    ['rtk --version', "an option of the wrapper's own"],
    ['rtk git status', 'another subcommand'],
    ['rtk git commit --template=/etc/passwd', 'a path outside bounds inside the wrapper'],
    ['/usr/local/bin/rtk git commit', 'the wrapper by path'],
    ['rtk rtk rtk rtk rtk git commit', 'nesting deeper than is seen through'],
  ])('asks for %j (%s)', (line) => {
    expect(allowed(line)).toBe(false);
  });

  it('says which inner command is not listed', () => {
    expect(commandInBounds('rtk proxy rm -rf ~', entries, bounds)).toEqual({ allowed: false, reason: expect.stringMatching(/"rm -rf ~" is not on the always-allowed list/) });
  });

  it('sees through to the inner command, and only through known forms', () => {
    expect(unwrapCommand(['rtk', 'git', 'status'])).toEqual(['git', 'status']);
    expect(unwrapCommand(['rtk', 'proxy', 'ls', '-la'])).toEqual(['ls', '-la']);
    expect(unwrapCommand(['rtk', 'gain'])).toEqual(['rtk', 'gain']);
    expect(unwrapCommand(['rtk', '-v', 'git'])).toEqual(['rtk', '-v', 'git']);
    expect(unwrapCommand(['notawrapper', 'git'])).toEqual(['notawrapper', 'git']);
  });

  it("names the inner command's paths outside the bounds", () => {
    expect(outsidePaths('rtk proxy cat ~/.ssh/config', bounds)).toEqual(['/Users/me/.ssh/config']);
  });
});

describe('the offer for a wrapped command', () => {
  it('is the command inside it', () => {
    expect(commandOffer('rtk git commit -m d1', bounds)).toEqual(['git', 'commit']);
    expect(commandOffer('rtk proxy gpg --sign x', bounds)).toEqual(['gpg']);
  });

  it('is nothing for the wrapper alone, its own subcommands, or what may never be an entry', () => {
    expect(commandOffer('rtk gain', bounds)).toBeUndefined();
    expect(commandOffer('rtk proxy sudo ls', bounds)).toBeUndefined();
    expect(commandOffer('rtk git -c x=y commit', bounds)).toBeUndefined();
  });
});
