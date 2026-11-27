import { describe, expect, test } from 'vitest';
import { bundleLine, diskLine, hostLines, lingeringLine, LOW_DISK_BYTES, offlineStatusLines, serviceLine, sizeText, type HostFacts } from './node-host.ts';

const facts = (change: Partial<HostFacts> = {}): HostFacts => ({
  user: 'kestrel',
  lingering: 'on',
  service: { manager: 'systemd', installed: true, active: true, mainPid: 4242 },
  disk: { path: '/home/user/.kestrel', freeBytes: 50 * 1024 ** 3 },
  bundle: { version: '0.0.34', path: '/home/user/.kestrel/node/0.0.34' },
  ...change,
});

describe('lingeringLine', () => {
  test('off says what happens without it and the one command, which needs an administrator', () => {
    const line = lingeringLine('off', 'kestrel');
    expect(line).toContain('stops when your last login session ends and does not start again after a reboot');
    expect(line).toContain('sudo loginctl enable-linger kestrel');
  });

  test('on and unknown say so', () => {
    expect(lingeringLine('on', 'kestrel')).toMatch(/^Lingering: on/);
    expect(lingeringLine('unknown', 'kestrel')).toBe('Lingering: not known (this system has no systemd)');
  });
});

describe('serviceLine', () => {
  test('the node systemd started says it runs under systemd', () => {
    expect(serviceLine(facts().service, 4242)).toBe('Service: running under systemd (kestrel-node.service)');
  });

  test('a node started by hand says so, whatever the service is doing', () => {
    expect(serviceLine(facts().service, 99)).toContain('this node was started by hand');
    expect(serviceLine({ manager: 'systemd', installed: false }, 99)).toBe('Service: not installed; this node was started by hand.');
    expect(serviceLine({ manager: 'systemd', installed: true, active: false, mainPid: null }, 99)).toContain('but not running; this node was started by hand');
  });

  test('with no node answering, it says how to start one', () => {
    expect(serviceLine({ manager: 'systemd', installed: true, active: false, mainPid: null }, null)).toContain('Start it with "kestrel-node start"');
    expect(serviceLine({ manager: 'systemd', installed: false }, null)).toContain('"kestrel-node run"');
    expect(serviceLine({ manager: 'none' }, null)).toContain('no systemd user manager');
    expect(serviceLine(facts().service, null)).toContain('does not answer yet. See "kestrel-node logs"');
  });
});

describe('disk and bundle', () => {
  test('sizes are short', () => {
    expect(sizeText(512)).toBe('512 bytes');
    expect(sizeText(1536)).toBe('1.5 KB');
    expect(sizeText(50 * 1024 ** 3)).toBe('50.0 GB');
    expect(sizeText(300 * 1024 ** 2)).toBe('300 MB');
  });

  test('free disk in Kestrel’s folder, and low when it is', () => {
    expect(diskLine(facts().disk)).toBe('Free disk in /home/user/.kestrel: 50.0 GB.');
    expect(diskLine({ path: '/x', freeBytes: LOW_DISK_BYTES - 1 })).toContain('Low:');
    expect(diskLine(null)).toBe('Free disk: could not be measured.');
  });

  test('the installed bundle, and a restart when the running node is older', () => {
    expect(bundleLine(facts().bundle, '0.0.34')).toBe('Installed bundle: 0.0.34 (/home/user/.kestrel/node/0.0.34).');
    expect(bundleLine(facts().bundle, '0.0.33')).toContain('The node runs 0.0.33: restart it to use 0.0.34');
    expect(bundleLine(null, '0.0.34')).toContain('runs from a checkout');
  });
});

describe('hostLines and the offline status', () => {
  test('four lines in order: service, lingering, disk, bundle', () => {
    const lines = hostLines(facts({ lingering: 'off' }), 4242, '0.0.34');
    expect(lines).toHaveLength(4);
    expect(lines.map((l) => l.split(':')[0])).toEqual(['Service', 'Lingering', 'Free disk in /home/user/.kestrel', 'Installed bundle']);
  });

  test('with no node answering, the terminal says so first, then what it can see', () => {
    const lines = offlineStatusLines('/home/user/.kestrel/node.sock', facts({ service: { manager: 'systemd', installed: true, active: false, mainPid: null } }));
    expect(lines[0]).toBe('No worker node is running here: nothing answers at /home/user/.kestrel/node.sock.');
    expect(lines[1]).toContain('kestrel-node start');
    expect(lines).toHaveLength(5);
  });
});
