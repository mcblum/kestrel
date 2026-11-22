import { describe, expect, test } from 'vitest';
import { findIn, installDirs, programNames, spawnTarget } from './find-program.ts';

describe('finding an agent’s program', () => {
  test('macOS and Linux look for the bare name; Windows for .exe and npm’s .cmd', () => {
    expect(programNames('codex', 'mac')).toEqual(['codex']);
    expect(programNames('codex', 'linux')).toEqual(['codex']);
    expect(programNames('codex', 'windows')).toEqual(['codex.exe', 'codex.cmd']);
  });

  test('the first folder that has it wins, and the .exe before the .cmd in one folder', () => {
    const present = new Set(['/b/codex', '/c/codex']);
    expect(findIn(['/a', '/b', '/c'], 'codex', 'linux', (path) => present.has(path))).toBe('/b/codex');
    expect(findIn(['/a'], 'codex', 'linux', () => false)).toBeNull();
    const names: string[] = [];
    findIn(['dir'], 'codex', 'windows', (path) => (names.push(path), false));
    expect(names.map((path) => path.replace(/\\/g, '/'))).toEqual(['dir/codex.exe', 'dir/codex.cmd']);
  });

  test('each platform adds its own usual install folders', () => {
    expect(installDirs('/Users/someone', 'mac')[0]).toBe('/opt/homebrew/bin');
    expect(installDirs('/home/someone', 'linux')).not.toContain('/opt/homebrew/bin');
    expect(installDirs('/home/someone', 'linux')).toContain('/usr/local/bin');
    const windows = installDirs('C:/Users/someone', 'windows', { APPDATA: 'C:/Users/someone/AppData/Roaming' }).map((dir) => dir.replace(/\\/g, '/'));
    expect(windows[0]).toBe('C:/Users/someone/AppData/Roaming/npm');
    expect(windows).not.toContain('/usr/local/bin');
  });

  test('a program is started as itself, except a Windows .cmd, which goes through the shell, quoted', () => {
    expect(spawnTarget('/usr/local/bin/codex', 'linux')).toEqual({ command: '/usr/local/bin/codex', shell: false });
    expect(spawnTarget('C:\\Tools\\codex.exe', 'windows')).toEqual({ command: 'C:\\Tools\\codex.exe', shell: false });
    expect(spawnTarget('C:\\Users\\some one\\AppData\\Roaming\\npm\\codex.cmd', 'windows')).toEqual({ command: '"C:\\Users\\some one\\AppData\\Roaming\\npm\\codex.cmd"', shell: true });
    // The same name on a Mac is just a file.
    expect(spawnTarget('/tmp/odd.cmd', 'mac').shell).toBe(false);
  });
});
