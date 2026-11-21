import { describe, expect, it } from 'vitest';
import { isUnsandboxed, shellSandbox, UNSANDBOXED_NOTE } from './sandbox.ts';

const child = { directory: '/data/worktrees/child', permission: 'ask' as const, confineShell: true };
const repoOf = (path: string) => (path === '/data/worktrees/child' ? '/code/shop' : null);

describe("a child session's shell sandbox", () => {
  it('lets commands write in the worktree and its repository’s git folder, nowhere else', () => {
    expect(shellSandbox(child, repoOf)).toEqual({
      enabled: true,
      // Approvals stay as the session's mode has them: being sandboxed does not wave a command through.
      autoAllowBashIfSandboxed: false,
      // A command that cannot work inside may be run again outside, which always asks (see the hook).
      allowUnsandboxedCommands: true,
      filesystem: { allowWrite: ['/data/worktrees/child', '/code/shop/.git'] },
      network: { allowedDomains: ['*'] },
    });
  });

  it('keeps a child in a plain folder to that folder', () => {
    expect(shellSandbox({ ...child, directory: '/plain' }, repoOf)?.filesystem).toEqual({ allowWrite: ['/plain'] });
  });

  it('holds in every mode that asks, and not in Bypass or for a session that runs no commands', () => {
    for (const permission of ['ask', 'edits', 'auto', 'plan'] as const) expect(shellSandbox({ ...child, permission }, repoOf)?.enabled).toBe(true);
    expect(shellSandbox({ ...child, permission: 'bypass' }, repoOf)).toBeUndefined();
    expect(shellSandbox({ ...child, permission: 'readonly' }, repoOf)).toBeUndefined();
  });

  it('lets a signed commit through when the repository signs: GnuPG read, its agent sockets reachable, nothing writable', () => {
    const signing = { read: ['/Users/me/.gnupg'], sockets: ['/Users/me/.gnupg/S.gpg-agent', '/Users/me/.gnupg/S.keyboxd'] };
    const sandbox = shellSandbox({ ...child, commitSigning: signing }, repoOf)!;
    expect(sandbox.filesystem).toEqual({ allowWrite: ['/data/worktrees/child', '/code/shop/.git'], allowRead: ['/Users/me/.gnupg'] });
    expect(sandbox.network).toEqual({ allowedDomains: ['*'], allowUnixSockets: ['/Users/me/.gnupg/S.gpg-agent', '/Users/me/.gnupg/S.keyboxd'] });
    expect(sandbox.network?.allowAllUnixSockets).toBeUndefined();
  });

  it('lets nothing for signing through when the repository does not sign', () => {
    const sandbox = shellSandbox(child, repoOf)!;
    expect(sandbox.filesystem).not.toHaveProperty('allowRead');
    expect(sandbox.network).not.toHaveProperty('allowUnixSockets');
  });

  it('is only for a session Kestrel marked', () => {
    expect(shellSandbox({ ...child, confineShell: false }, repoOf)).toBeUndefined();
    expect(shellSandbox({ directory: '/x', permission: 'ask' }, repoOf)).toBeUndefined();
  });
});

describe('a command asked to run outside the sandbox', () => {
  it('is recognised by the flag Claude sets on the call', () => {
    expect(isUnsandboxed('Bash', { command: 'git commit', dangerouslyDisableSandbox: true })).toBe(true);
    expect(isUnsandboxed('Bash', { command: 'git commit' })).toBe(false);
    expect(isUnsandboxed('Bash', { command: 'x', dangerouslyDisableSandbox: false })).toBe(false);
    expect(isUnsandboxed('Write', { dangerouslyDisableSandbox: true })).toBe(false);
    expect(UNSANDBOXED_NOTE).toMatch(/outside/i);
  });
});
