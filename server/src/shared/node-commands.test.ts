import { describe, expect, test } from 'vitest';
import { CLI_COMMAND_NAMES, isNodeCommand, isTerminalCommand, NODE_COMMAND_NAMES, NODE_COMMANDS, notBuiltReason, parseNodeRequest, TERMINAL_COMMAND_NAMES, unknownCommandReason } from './node-commands.ts';

describe('the closed list of node commands', () => {
  test('names every command the socket answers, and only those', () => {
    expect([...NODE_COMMAND_NAMES].sort()).toEqual(['agents', 'git', 'join', 'setup', 'status', 'stop', 'uninstall']);
  });

  test('status, stop, join, agents, git and uninstall are built in this version', () => {
    const built = NODE_COMMAND_NAMES.filter((name) => NODE_COMMANDS[name].built);
    expect(built.sort()).toEqual(['agents', 'git', 'join', 'status', 'stop', 'uninstall']);
  });

  test('start and logs are the terminal’s alone: they work with no node running, so the socket never takes them', () => {
    expect([...TERMINAL_COMMAND_NAMES].sort()).toEqual(['logs', 'start']);
    for (const name of TERMINAL_COMMAND_NAMES) {
      expect(isNodeCommand(name)).toBe(false);
      expect(parseNodeRequest(JSON.stringify({ command: name }))).toMatchObject({ ok: false });
    }
    expect(isTerminalCommand('status')).toBe(false);
  });

  test('kestrel-node takes every command of both lists, each once', () => {
    expect([...CLI_COMMAND_NAMES].sort()).toEqual([...NODE_COMMAND_NAMES, ...TERMINAL_COMMAND_NAMES].sort());
  });

  test('recognises a command name and nothing inherited or made up', () => {
    expect(isNodeCommand('status')).toBe(true);
    expect(isNodeCommand('toString')).toBe(false);
    expect(isNodeCommand('rm')).toBe(false);
    expect(isNodeCommand(undefined)).toBe(false);
  });
});

describe('parseNodeRequest', () => {
  test('reads a command from a line of JSON', () => {
    expect(parseNodeRequest('{"command":"status"}')).toEqual({ ok: true, command: 'status' });
  });

  test('refuses a line that is not JSON, saying how to ask', () => {
    const answer = parseNodeRequest('status');
    expect(answer).toMatchObject({ ok: false });
    expect(answer.ok === false && answer.reason).toContain('{"command":"status"}');
  });

  test('refuses a request with no command, or a command that is not text', () => {
    expect(parseNodeRequest('{}')).toMatchObject({ ok: false });
    expect(parseNodeRequest('{"command":4}')).toMatchObject({ ok: false });
    expect(parseNodeRequest('null')).toMatchObject({ ok: false });
  });

  test('refuses an unknown command and lists the ones there are', () => {
    const answer = parseNodeRequest('{"command":"format-disk"}');
    expect(answer).toEqual({ ok: false, reason: unknownCommandReason('format-disk') });
    expect(unknownCommandReason('format-disk')).toContain('status, stop, join');
  });

  test('the not-built reason names the command', () => {
    expect(notBuiltReason('agents')).toBe('"agents" is not built yet in this version of kestrel-node.');
  });
});
