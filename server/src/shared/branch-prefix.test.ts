// The branch name prefix setting: checking a custom prefix, reading back what was stored, resolving it, and the name it makes.
import { describe, expect, it } from 'vitest';
import { branchName, customPrefixProblem, DEFAULT_BRANCH_PREFIX, resolvePrefix, sanitizeBranchPrefix } from './branch-prefix.ts';

describe('customPrefixProblem', () => {
  it('accepts plain names and paths of them', () => {
    for (const ok of ['mcblum', 'team/mcblum', 'feat', 'a.b', 'x_y-z', 'release/2026.11']) expect(customPrefixProblem(ok)).toBeNull();
  });

  it('refuses what git would refuse in a branch name, with the reason', () => {
    const cases: [string, RegExp][] = [
      ['', /Enter/],
      ['my prefix', /spaces/],
      ['a..b', /\.\./],
      ['a~b', /not allowed/],
      ['a^b', /not allowed/],
      ['a:b', /not allowed/],
      ['a?b', /not allowed/],
      ['a*b', /not allowed/],
      ['a[b', /not allowed/],
      ['a\\b', /not allowed/],
      ['a@{b', /@\{/],
      ['-x', /start with "-"/],
      ['/x', /start or end/],
      ['x/', /start or end/],
      ['x.lock', /\.lock/],
      ['x.lock/y', /\.lock/],
      ['a//b', /empty/],
      ['.hidden', /start with "\."/],
      ['x'.repeat(61), /under 60/],
    ];
    for (const [text, reason] of cases) expect(customPrefixProblem(text), text).toMatch(reason);
  });
});

describe('sanitizeBranchPrefix', () => {
  it('is the default for nothing or junk', () => {
    expect(sanitizeBranchPrefix(null)).toEqual(DEFAULT_BRANCH_PREFIX);
    expect(sanitizeBranchPrefix('mcblum')).toEqual(DEFAULT_BRANCH_PREFIX);
    expect(sanitizeBranchPrefix({ choice: 'nope', custom: 'x' })).toEqual({ choice: 'kestrel', custom: 'x' });
  });

  it('keeps a good stored choice and drops an unusable custom prefix', () => {
    expect(sanitizeBranchPrefix({ choice: 'custom', custom: 'team/me' })).toEqual({ choice: 'custom', custom: 'team/me' });
    // Saved as "GitHub username" by an older version: now "Your username".
    expect(sanitizeBranchPrefix({ choice: 'github', custom: '' })).toEqual({ choice: 'username', custom: '' });
    expect(sanitizeBranchPrefix({ choice: 'none', custom: 'bad name' })).toEqual({ choice: 'none', custom: '' });
    expect(sanitizeBranchPrefix({ choice: 'custom', custom: 'bad name' })).toEqual({ choice: 'kestrel', custom: '' });
  });
});

describe('resolvePrefix', () => {
  it('gives each choice its prefix', () => {
    expect(resolvePrefix({ choice: 'kestrel', custom: '' }, 'mcblum')).toBe('kestrel');
    expect(resolvePrefix({ choice: 'none', custom: 'x' }, 'mcblum')).toBe('');
    expect(resolvePrefix({ choice: 'custom', custom: 'team/me' }, null)).toBe('team/me');
    expect(resolvePrefix({ choice: 'username', custom: '' }, 'mcblum')).toBe('mcblum');
  });

  it('falls back to kestrel when the GitHub login is missing or unusable', () => {
    expect(resolvePrefix({ choice: 'username', custom: '' }, null)).toBe('kestrel');
    expect(resolvePrefix({ choice: 'username', custom: '' }, 'bad login')).toBe('kestrel');
  });
});

describe('branchName', () => {
  it('is prefix/slug-short, or slug-short with no prefix', () => {
    expect(branchName('mcblum', 'Fix login!', '3fa2b1c9-aaaa-bbbb')).toBe('mcblum/fix-login-3fa2b1c9');
    expect(branchName('', 'Fix login!', '3fa2b1c9-aaaa-bbbb')).toBe('fix-login-3fa2b1c9');
    expect(branchName('kestrel', '', '12345678')).toBe('kestrel/session-12345678');
  });
});
