import { describe, expect, test } from 'vitest';
import { DEFAULT_LOG_LINES, MAX_LOG_LINES, parseAgentsArgs, parseCliArgs, parseLogOptions } from './args.ts';

describe('parseCliArgs: kestrel’s own commands', () => {
  test('no argument is the overview; version and upgrade are kestrel’s own', () => {
    expect(parseCliArgs([])).toEqual({ action: 'overview' });
    expect(parseCliArgs(['version'])).toEqual({ action: 'version' });
    expect(parseCliArgs(['--version'])).toEqual({ action: 'version' });
    expect(parseCliArgs(['version', 'now'])).toMatchObject({ action: 'error', scope: 'top' });
    expect(parseCliArgs(['upgrade'])).toEqual({ action: 'command', command: 'upgrade' });
    expect(parseCliArgs(['upgrade', '0.0.35-beta.2'])).toEqual({ action: 'command', command: 'upgrade', version: '0.0.35-beta.2' });
    expect(parseCliArgs(['upgrade', 'latest'])).toMatchObject({ action: 'error', scope: 'top', reason: expect.stringContaining('takes one version') });
  });

  test('help in any of its spellings, for kestrel, the node group, or one command', () => {
    for (const word of ['help', '--help', '-h']) expect(parseCliArgs([word])).toEqual({ action: 'help' });
    expect(parseCliArgs(['help', 'upgrade'])).toEqual({ action: 'help', command: 'upgrade' });
    expect(parseCliArgs(['upgrade', '-h'])).toEqual({ action: 'help', command: 'upgrade' });
    expect(parseCliArgs(['help', 'version'])).toEqual({ action: 'help', command: 'version' });
    expect(parseCliArgs(['help', 'node'])).toEqual({ action: 'help', command: 'node' });
    expect(parseCliArgs(['help', 'node', 'git'])).toEqual({ action: 'help', command: 'git' });
    expect(parseCliArgs(['help', 'format-disk'])).toMatchObject({ action: 'error', scope: 'top', reason: expect.stringContaining('is not a kestrel command') });
  });

  test('anything else is an error that lists kestrel’s own commands', () => {
    const answer = parseCliArgs(['restart']);
    expect(answer).toEqual({ action: 'error', scope: 'top', reason: '"restart" is not a kestrel command. The commands are node, upgrade, version, help.' });
  });
});

describe('parseCliArgs: the node group', () => {
  test('kestrel node alone, and node help, list the group’s commands', () => {
    expect(parseCliArgs(['node'])).toEqual({ action: 'help', command: 'node' });
    expect(parseCliArgs(['node', 'help'])).toEqual({ action: 'help', command: 'node' });
    expect(parseCliArgs(['node', '--help'])).toEqual({ action: 'help', command: 'node' });
    expect(parseCliArgs(['node', 'help', 'agents'])).toEqual({ action: 'help', command: 'agents' });
    expect(parseCliArgs(['node', 'configure', '--help'])).toEqual({ action: 'help', command: 'configure' });
    expect(parseCliArgs(['node', 'run', '-h'])).toEqual({ action: 'help', command: 'run' });
    expect(parseCliArgs(['node', 'help', 'nope'])).toMatchObject({ action: 'error', scope: 'node' });
  });

  test('run starts the node (what the unit runs); configure is the onboarding', () => {
    expect(parseCliArgs(['node', 'run'])).toEqual({ action: 'run' });
    expect(parseCliArgs(['node', 'configure'])).toEqual({ action: 'command', command: 'configure' });
    expect(parseCliArgs(['node', 'configure', '--yes'])).toEqual({ action: 'error', scope: 'node', reason: '"configure" takes no arguments.' });
    expect(parseCliArgs(['node', 'run', 'now'])).toMatchObject({ action: 'error', scope: 'node' });
  });

  test('the node’s commands and the terminal’s are both under the group', () => {
    for (const command of ['status', 'stop', 'join', 'uninstall', 'start']) expect(parseCliArgs(['node', command])).toEqual({ action: 'command', command });
    expect(parseCliArgs(['node', 'agents'])).toEqual({ action: 'command', command: 'agents', agents: { only: null, yes: false, check: false } });
    expect(parseCliArgs(['node', 'logs', '-f', '-n', '50'])).toEqual({ action: 'command', command: 'logs', logs: { follow: true, lines: 50 } });
    expect(parseCliArgs(['node', 'logs'])).toEqual({ action: 'command', command: 'logs', logs: { follow: false, lines: DEFAULT_LOG_LINES } });
  });

  test('status --json, git and git --yes; extra words are errors under the group', () => {
    expect(parseCliArgs(['node', 'status', '--json'])).toEqual({ action: 'command', command: 'status', json: true });
    expect(parseCliArgs(['node', 'git'])).toEqual({ action: 'command', command: 'git', git: { yes: false, manual: false } });
    expect(parseCliArgs(['node', 'git', '-y'])).toEqual({ action: 'command', command: 'git', git: { yes: true, manual: false } });
    expect(parseCliArgs(['node', 'git', '--manual', '--yes'])).toEqual({ action: 'command', command: 'git', git: { yes: true, manual: true } });
    expect(parseCliArgs(['node', 'git', '--force'])).toEqual({ action: 'error', scope: 'node', reason: '"git" does not take "--force". It takes --yes and --manual.' });
    expect(parseCliArgs(['node', 'status', '--yes'])).toEqual({ action: 'error', scope: 'node', reason: '"status" takes only --json.' });
    expect(parseCliArgs(['node', 'uninstall', '--yes'])).toEqual({ action: 'error', scope: 'node', reason: '"uninstall" takes no arguments.' });
  });

  test('a word that is not a node command lists the group’s commands', () => {
    expect(parseCliArgs(['node', 'restart'])).toEqual({
      action: 'error',
      scope: 'node',
      reason: '"restart" is not a kestrel node command. The commands are configure, status, join, agents, git, start, stop, logs, uninstall, run.',
    });
  });
});

describe('parseCliArgs: the first version’s words, with no group', () => {
  test('what an installed 0.0.34-beta.1 runs: its unit’s run, its install script’s setup', () => {
    expect(parseCliArgs(['run'])).toEqual({ action: 'run' });
    expect(parseCliArgs(['setup'])).toEqual({ action: 'command', command: 'configure' });
    expect(parseCliArgs(['node', 'setup'])).toEqual({ action: 'command', command: 'configure' });
  });

  test('every node command still works with no group, as it did', () => {
    for (const command of ['status', 'stop', 'join', 'uninstall', 'start', 'configure']) expect(parseCliArgs([command])).toEqual({ action: 'command', command });
    expect(parseCliArgs(['status', '--json'])).toEqual({ action: 'command', command: 'status', json: true });
    expect(parseCliArgs(['agents', 'claude', '--yes'])).toEqual({ action: 'command', command: 'agents', agents: { only: 'claude', yes: true, check: false } });
    expect(parseCliArgs(['logs', '-n500'])).toEqual({ action: 'command', command: 'logs', logs: { follow: false, lines: 500 } });
    expect(parseCliArgs(['git', '--yes'])).toEqual({ action: 'command', command: 'git', git: { yes: true, manual: false } });
  });

  test('their help, by every spelling the first version took', () => {
    expect(parseCliArgs(['help', 'git'])).toEqual({ action: 'help', command: 'git' });
    expect(parseCliArgs(['help', 'setup'])).toEqual({ action: 'help', command: 'configure' });
    expect(parseCliArgs(['setup', '--help'])).toEqual({ action: 'help', command: 'configure' });
    expect(parseCliArgs(['help', 'run'])).toEqual({ action: 'help', command: 'run' });
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
    expect(parseCliArgs(['node', 'agents', 'claude', '--yes'])).toEqual({ action: 'command', command: 'agents', agents: { only: 'claude', yes: true, check: false } });
  });

  test('refuses two agents, and anything else, saying what it takes', () => {
    expect(parseAgentsArgs(['codex', 'claude'])).toEqual({ ok: false, reason: '"agents" takes one agent at a time.' });
    expect(parseAgentsArgs(['gemini'])).toEqual({ ok: false, reason: '"agents" does not take "gemini". It takes an agent (claude, codex or opencode), --yes and --check.' });
    expect(parseCliArgs(['node', 'agents', '--force'])).toMatchObject({ action: 'error', scope: 'node', reason: expect.stringContaining('"agents" does not take "--force"') });
  });
});
