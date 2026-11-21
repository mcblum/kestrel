// Tests run git without the developer's configuration: a global setting such as commit signing
// must not reach a test repository.
import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import { makeRepo } from './test-repo.ts';

// Builds real git repositories: room under a loaded machine (test-timeouts.ts).
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('git in tests', () => {
  it('reads no global or system config, so commits are never signed', () => {
    const repo = makeRepo();
    expect(git(repo, 'config', '--global', '--list')).toBe('');
    expect(() => git(repo, 'config', 'commit.gpgsign')).toThrow();
    expect(git(repo, 'log', '-1', '--format=%G?')).toBe('N');
  });
});
