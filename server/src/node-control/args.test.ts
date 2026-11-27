import { describe, expect, test } from 'vitest';
import { DEFAULT_LOG_LINES, MAX_LOG_LINES, parseAgentsArgs, parseCliArgs, parseLogOptions, usage } from './args.ts';

describe('parseCliArgs', () => {
  test('no argument starts the node, and so does run', () => {
    expect(parseCliArgs([])).toEqual({ action: 'run' });
    expect(parseCliArgs(['run'])).toEqual({ action: 'run' });
  });

  test('the node’s commands and the terminal’s are both commands', () => {
    for (const command of ['status', 'stop', 'join', 'uninstall', 'start']) expect(parseCliArgs([command])).toEqual({ action: 'command', command });
    expect(parseCliArgs(['agents'])).toEqual({ action: 'command', command: 'agents', agents: { only: null, yes: false, check: false } });
  });

  test('logs takes its options, with defaults', () => {
    expect(parseCliArgs(['logs'])).toEqual({ action: 'command', command: 'logs', logs: { follow: false, lines: DEFAULT_LOG_LINES } });
    expect(parseCliArgs(['logs', '-f', '-n', '50'])).toEqual({ action: 'command', command: 'logs', logs: { follow: true, lines: 50 } });
  });

  test('help in any of its spellings', () => {
    for (const word of ['help', '--help', '-h']) expect(parseCliArgs([word])).toEqual({ action: 'help' });
  });

  test('anything else is an error that lists the commands, start and logs among them', () => {
    const answer = parseCliArgs(['restart']);
    expect(answer).toMatchObject({ action: 'error' });
    expect(answer.action === 'error' && answer.reason).toContain('status, start, stop, logs, join');
  });

  test('a command with extra words is an error', () => {
    expect(parseCliArgs(['status', '--yes'])).toMatchObject({ action: 'error', reason: '"status" takes only --json.' });
    expect(parseCliArgs(['uninstall', '--yes'])).toMatchObject({ action: 'error', reason: '"uninstall" takes no arguments.' });
    expect(parseCliArgs(['run', 'now'])).toMatchObject({ action: 'error' });
  });

  test('status --json, git and git --yes; git takes nothing else', () => {
    expect(parseCliArgs(['status', '--json'])).toEqual({ action: 'command', command: 'status', json: true });
    expect(parseCliArgs(['git'])).toEqual({ action: 'command', command: 'git', git: { yes: false, manual: false } });
    expect(parseCliArgs(['git', '-y'])).toEqual({ action: 'command', command: 'git', git: { yes: true, manual: false } });
    expect(parseCliArgs(['git', '--manual', '--yes'])).toEqual({ action: 'command', command: 'git', git: { yes: true, manual: true } });
    expect(parseCliArgs(['git', '--force'])).toEqual({ action: 'error', reason: '"git" does not take "--force". It takes --yes and --manual.' });
  });

  test('the usage names every command, with what each does', () => {
    const text = usage();
    expect(text).toContain('kestrel-node [run | status | start | stop | logs | join | agents | git | setup | uninstall]');
    expect(text).toMatch(/ {2}logs +Read the node’s log/);
    expect(text).toMatch(/ {2}start +Start the node’s service/);
  });
});

describe('parseLogOptions', () => {
  test('every spelling of follow and of a line count', () => {
    expect(parseLogOptions(['--follow'])).toEqual({ ok: true, options: { follow: true, lines: DEFAULT_LOG_LINES } });
    expect(parseLogOptions(['-n500'])).toEqual({ ok: true, options: { follow: false, lines: 500 } });
    expect(parseLogOptions(['--lines=7', '-f'])).toEqual({ ok: true, options: { follow: true, lines: 7 } });
    expect(parseLogOptions(['--lines', '0'])).toEqual({ ok: true, options: { follow: false, lines: 0 } });
  });

  test('refuses a count that is missing, not a whole number, negative or too large', () => {
    for (const args of [['-n'], ['-n', 'ten'], ['-n', '-3'], ['-n', '1.5'], ['--lines='], ['-n', String(MAX_LOG_LINES + 1)]]) {
      expect(parseLogOptions(args)).toMatchObject({ ok: false, reason: expect.stringContaining('-n takes a number') });
    }
  });

  test('refuses anything else, saying what it takes', () => {
    expect(parseLogOptions(['--since', 'today'])).toEqual({ ok: false, reason: '"logs" does not take "--since". It takes -f (follow) and -n <lines>.' });
  });
});

describe('parseAgentsArgs', () => {
  test('one agent, --yes (or -y) and --check, in any order', () => {
    expect(parseAgentsArgs([])).toEqual({ ok: true, options: { only: null, yes: false, check: false } });
    expect(parseAgentsArgs(['codex'])).toEqual({ ok: true, options: { only: 'codex', yes: false, check: false } });
    expect(parseAgentsArgs(['--check', 'opencode', '-y'])).toEqual({ ok: true, options: { only: 'opencode', yes: true, check: true } });
    expect(parseCliArgs(['agents', 'claude', '--yes'])).toEqual({ action: 'command', command: 'agents', agents: { only: 'claude', yes: true, check: false } });
  });

  test('refuses two agents, and anything else, saying what it takes', () => {
    expect(parseAgentsArgs(['codex', 'claude'])).toEqual({ ok: false, reason: '"agents" takes one agent at a time.' });
    expect(parseAgentsArgs(['gemini'])).toEqual({ ok: false, reason: '"agents" does not take "gemini". It takes an agent (claude, codex or opencode), --yes and --check.' });
    expect(parseCliArgs(['agents', '--force'])).toMatchObject({ action: 'error', reason: expect.stringContaining('"agents" does not take "--force"') });
  });
});
