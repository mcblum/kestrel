import { describe, expect, test, vi } from 'vitest';
import { endTree, scriptShell, terminalShell } from './host.ts';
import { platformOf } from './shared/platform.ts';

describe('platformOf', () => {
  test('names the three platforms, and treats any other Unix as Linux', () => {
    expect(platformOf('darwin')).toBe('mac');
    expect(platformOf('win32')).toBe('windows');
    expect(platformOf('linux')).toBe('linux');
    expect(platformOf('freebsd')).toBe('linux');
  });
});

describe('terminalShell', () => {
  test('macOS and Linux open the user’s own shell as a login shell', () => {
    expect(terminalShell({ SHELL: '/opt/homebrew/bin/fish' }, 'mac')).toEqual({ file: '/opt/homebrew/bin/fish', args: ['-l'] });
    expect(terminalShell({ SHELL: '/usr/bin/zsh' }, 'linux')).toEqual({ file: '/usr/bin/zsh', args: ['-l'] });
  });

  test('with no SHELL each system falls back to its own default', () => {
    expect(terminalShell({}, 'mac').file).toBe('/bin/zsh');
    expect(terminalShell({}, 'linux').file).toBe('/bin/bash');
  });

  test('Windows opens PowerShell with no login flag, whatever SHELL says, unless another is named', () => {
    expect(terminalShell({ SHELL: '/usr/bin/bash' }, 'windows')).toEqual({ file: 'powershell.exe', args: [] });
    expect(terminalShell({ KESTREL_WINDOWS_SHELL: 'pwsh.exe' }, 'windows')).toEqual({ file: 'pwsh.exe', args: [] });
  });
});

describe('scriptShell', () => {
  test('macOS and Linux hand the script to the login shell as one argument', () => {
    expect(scriptShell({ SHELL: '/bin/zsh' }, 'pnpm install && pnpm dev', 'mac')).toEqual({ file: '/bin/zsh', args: ['-l', '-c', 'pnpm install && pnpm dev'], verbatim: false });
    expect(scriptShell({}, 'make', 'linux').file).toBe('/bin/bash');
  });

  test('Windows hands it to cmd.exe after /c, quoted once and not re-quoted by Node', () => {
    expect(scriptShell({ ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, 'pnpm install && pnpm dev', 'windows')).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '"pnpm install && pnpm dev"'],
      verbatim: true,
    });
    expect(scriptShell({}, 'dir', 'windows').file).toBe('cmd.exe');
  });
});

describe('endTree', () => {
  test('macOS and Linux signal the whole process group', () => {
    const kill = vi.fn();
    const run = vi.fn(async () => undefined);
    endTree(4321, 'SIGTERM', 'linux', run, kill);
    endTree(4321, 'SIGKILL', 'mac', run, kill);
    expect(kill.mock.calls).toEqual([[-4321, 'SIGTERM'], [-4321, 'SIGKILL']]);
    expect(run).not.toHaveBeenCalled();
  });

  test('a group that is already gone is not an error', () => {
    expect(() => endTree(4321, 'SIGTERM', 'mac', vi.fn(async () => undefined), () => { throw new Error('ESRCH'); })).not.toThrow();
  });

  test('Windows ends the tree with taskkill and never signals', () => {
    const kill = vi.fn();
    const run = vi.fn(async () => undefined);
    endTree(4321, 'SIGTERM', 'windows', run, kill);
    expect(run).toHaveBeenCalledWith('taskkill', ['/pid', '4321', '/T', '/F']);
    expect(kill).not.toHaveBeenCalled();
  });
});
