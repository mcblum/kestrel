import { describe, expect, test } from 'vitest';
import { enableLingerCommand, lingeringOf, NODE_UNIT_NAME, nodeInstallPaths, serviceStateOf, serviceUnitText, UNIT_LAUNCHER, UNIT_STOP_TIMEOUT_S } from './node-service.ts';
import { SHUTDOWN_DEADLINE_MS } from './shutdown.ts';

const directive = (text: string, key: string): string[] =>
  text
    .split('\n')
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));

describe('serviceUnitText', () => {
  const unit = serviceUnitText();

  test('runs the installed launcher in the foreground, after the network', () => {
    expect(directive(unit, 'Type')).toEqual(['simple']);
    expect(directive(unit, 'ExecStart')).toEqual([`${UNIT_LAUNCHER} run`]);
    expect(UNIT_LAUNCHER).toBe('%h/.kestrel/node/current/bin/kestrel-node');
    expect(directive(unit, 'After')).toEqual(['network-online.target']);
    expect(directive(unit, 'Wants')).toEqual(['network-online.target']);
    expect(directive(unit, 'WantedBy')).toEqual(['default.target']);
  });

  test('stops with SIGTERM and waits longer than the server’s own shutdown before killing it', () => {
    expect(directive(unit, 'KillSignal')).toEqual(['SIGTERM']);
    expect(Number(directive(unit, 'TimeoutStopSec')[0])).toBe(UNIT_STOP_TIMEOUT_S);
    expect(UNIT_STOP_TIMEOUT_S * 1000).toBeGreaterThan(SHUTDOWN_DEADLINE_MS);
  });

  test('comes back after a failure, and what it writes is the user’s alone', () => {
    expect(directive(unit, 'Restart')).toEqual(['on-failure']);
    expect(directive(unit, 'UMask')).toEqual(['0077']);
  });

  test('sets no environment and holds nothing private: the launcher sets what the node needs', () => {
    expect(unit).not.toMatch(/^Environment/m);
    expect(unit).not.toMatch(/\/home\/|\/Users\/|sudo loginctl enable-linger [a-z]/);
    expect(unit.endsWith('\n')).toBe(true);
  });
});

describe('nodeInstallPaths', () => {
  test('everything lives in the user’s home folder', () => {
    expect(nodeInstallPaths('/home/user/')).toEqual({
      kestrel: '/home/user/.kestrel',
      bundles: '/home/user/.kestrel/node',
      current: '/home/user/.kestrel/node/current',
      unit: `/home/user/.config/systemd/user/${NODE_UNIT_NAME}`,
      link: '/home/user/.local/bin/kestrel-node',
    });
  });
});

describe('serviceStateOf', () => {
  test('no answer from systemctl, or no LoadState in it, is no user manager', () => {
    expect(serviceStateOf(null)).toEqual({ manager: 'none' });
    expect(serviceStateOf('Failed to connect to bus\n')).toEqual({ manager: 'none' });
  });

  test('a unit systemd cannot find is not installed', () => {
    expect(serviceStateOf('LoadState=not-found\nActiveState=inactive\nMainPID=0\n')).toEqual({ manager: 'systemd', installed: false });
  });

  test('an installed unit, running or not, with its main process', () => {
    expect(serviceStateOf('LoadState=loaded\nActiveState=active\nMainPID=4242\n')).toEqual({ manager: 'systemd', installed: true, active: true, mainPid: 4242 });
    expect(serviceStateOf('MainPID=0\nActiveState=failed\nLoadState=loaded')).toEqual({ manager: 'systemd', installed: true, active: false, mainPid: null });
    expect(serviceStateOf('LoadState=loaded\nActiveState=activating\nMainPID=7\n')).toMatchObject({ active: true, mainPid: 7 });
  });
});

describe('lingering', () => {
  test('on with the linger file, off without, unknown with no systemd', () => {
    expect(lingeringOf(true, true)).toBe('on');
    expect(lingeringOf(true, false)).toBe('off');
    expect(lingeringOf(false, true)).toBe('unknown');
  });

  test('the command names the user and needs an administrator', () => {
    expect(enableLingerCommand('kestrel')).toBe('sudo loginctl enable-linger kestrel');
  });
});
