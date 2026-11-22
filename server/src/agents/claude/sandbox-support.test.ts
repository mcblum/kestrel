import { describe, expect, it } from 'vitest';
import { isUnconfinedCommand, shellSandbox, unconfinedNote, unconfinedReason } from './sandbox.ts';
import { NO_SANDBOX_ON_WINDOWS, noSandboxOnLinux, sandboxSupport } from './sandbox-support.ts';

const all = () => true;
const none = () => false;

describe('whether this computer can sandbox commands', () => {
  it('a Mac always can', () => {
    expect(sandboxSupport('mac', none)).toEqual({ available: true });
  });

  it('Windows never can, and says so', () => {
    expect(sandboxSupport('windows', all)).toEqual({ available: false, reason: NO_SANDBOX_ON_WINDOWS });
  });

  it('Linux can with bubblewrap and socat, and names what is missing', () => {
    expect(sandboxSupport('linux', all)).toEqual({ available: true });
    expect(sandboxSupport('linux', (program) => program === 'bwrap')).toEqual({ available: false, reason: noSandboxOnLinux(['socat']) });
    expect(sandboxSupport('linux', none)).toEqual({ available: false, reason: 'the command sandbox on Linux needs bubblewrap and socat installed (then restart Kestrel)' });
  });
});

describe('a child session on a computer with no sandbox', () => {
  const child = { directory: '/data/worktrees/child', permission: 'auto' as const, confineShell: true };
  const unsupported = { ...child, sandboxSupport: { available: false as const, reason: NO_SANDBOX_ON_WINDOWS } };
  const repoOf = () => null;

  it('is not given a sandbox the SDK would fail to start', () => {
    expect(shellSandbox(unsupported, repoOf)).toBeUndefined();
    expect(shellSandbox({ ...child, sandboxSupport: { available: true } }, repoOf)?.enabled).toBe(true);
    // No word about the computer means it can, as before.
    expect(shellSandbox(child, repoOf)?.enabled).toBe(true);
  });

  it('has every shell command ask instead, with the reason', () => {
    expect(unconfinedReason(unsupported)).toBe(NO_SANDBOX_ON_WINDOWS);
    expect(isUnconfinedCommand('Bash', { command: 'git status' }, unsupported)).toBe(true);
    expect(isUnconfinedCommand('PowerShell', { command: 'Get-ChildItem' }, unsupported)).toBe(true);
    expect(unconfinedNote(NO_SANDBOX_ON_WINDOWS)).toBe("Not sandboxed (Claude Code has no command sandbox on Windows): it can change files outside this session's folder");
  });

  it('does not ask about tools that run no command', () => {
    expect(isUnconfinedCommand('Read', { file_path: 'a.ts' }, unsupported)).toBe(false);
    expect(isUnconfinedCommand('Bash', {}, unsupported)).toBe(false);
  });

  it('leaves alone a session that was never confined, runs no commands, or is in Bypass', () => {
    expect(unconfinedReason({ ...unsupported, confineShell: false })).toBeNull();
    expect(unconfinedReason({ ...unsupported, permission: 'readonly' })).toBeNull();
    expect(unconfinedReason({ ...unsupported, permission: 'bypass' })).toBeNull();
    expect(unconfinedReason({ ...child, sandboxSupport: { available: true } })).toBeNull();
    expect(isUnconfinedCommand('Bash', { command: 'ls' }, child)).toBe(false);
  });
});
