import { describe, expect, test } from 'vitest';
import { logCommand, logSourceOf, type LogFacts } from './logs.ts';

const facts = (change: Partial<LogFacts> = {}): LogFacts => ({ service: { manager: 'systemd', installed: true, active: true, mainPid: 1 }, journalctl: true, logFile: '/home/k/.kestrel/logs/node.log', logFileExists: true, ...change });

describe('logSourceOf', () => {
  test('the journal when the node is installed as a service and journalctl runs', () => {
    expect(logSourceOf(facts())).toEqual({ from: 'journal' });
    expect(logSourceOf(facts({ service: { manager: 'systemd', installed: true, active: false, mainPid: null } }))).toEqual({ from: 'journal' });
  });

  test('Kestrel’s own log file otherwise', () => {
    expect(logSourceOf(facts({ service: { manager: 'none' } }))).toEqual({ from: 'file', path: '/home/k/.kestrel/logs/node.log' });
    expect(logSourceOf(facts({ journalctl: false }))).toEqual({ from: 'file', path: '/home/k/.kestrel/logs/node.log' });
  });

  test('neither is a reason, naming where the log would be', () => {
    expect(logSourceOf(facts({ service: { manager: 'systemd', installed: false }, logFileExists: false }))).toMatchObject({ from: 'none', reason: expect.stringContaining('/home/k/.kestrel/logs/node.log') });
  });
});

describe('logCommand', () => {
  test('journalctl for the user unit, following when asked', () => {
    expect(logCommand({ from: 'journal' }, { follow: true, lines: 50 })).toEqual({ file: 'journalctl', args: ['--user', '--unit', 'kestrel-node.service', '--no-pager', '--output', 'short-iso', '--lines', '50', '--follow'] });
  });

  test('tail for the file, following it across a rotation', () => {
    expect(logCommand({ from: 'file', path: '/x/node.log' }, { follow: false, lines: 10 })).toEqual({ file: 'tail', args: ['-n', '10', '/x/node.log'] });
    expect(logCommand({ from: 'file', path: '/x/node.log' }, { follow: true, lines: 10 }).args).toContain('-F');
  });
});
