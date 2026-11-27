import { describe, expect, test } from 'vitest';
import { adminCommandRefusal, askAgentOf, askAgentText, cardCommandText, setupListText } from './setup-agent.ts';
import type { SetupLine, SetupList } from './setup-list.ts';

const line = (over: Partial<SetupLine> = {}): SetupLine => ({ id: 'tool:uv', group: 'tools', kind: 'install', title: 'Install uv', does: 'Runs this as you.', from: ['MacBook Pro'], secrets: [], done: false, action: { kind: 'install', tool: 'uv', why: [] }, run: 'user', command: { shell: 'sh', text: 'brew install uv' }, url: null, page: null, needs: [], dismissed: false, askAgent: true, items: null, ...over });
const mcp = line({ id: 'mcp:ha', group: 'mcp', kind: 'bring', title: 'ha', action: null, run: null, command: null, needs: ['tool:uv'], askAgent: false });
const list = (lines: SetupLine[]): SetupList => ({ here: { id: 'b', name: 'Mac mini', platform: 'mac' }, others: [{ id: 'a', name: 'MacBook Pro', readAt: 1 }], lines, problems: [] });

describe('askAgentOf', () => {
  test('offered on a line that needs judgment, and on any line that failed or waits; never on one done or dismissed', () => {
    expect(askAgentOf(line(), undefined)).toBe(true);
    expect(askAgentOf(mcp, undefined)).toBe(false);
    expect(askAgentOf(mcp, { state: 'failed', at: 1, reason: 'x', output: '' })).toBe(true);
    expect(askAgentOf(mcp, { state: 'waiting', at: 1, on: 'you' })).toBe(true);
    expect(askAgentOf(line({ done: true }), { state: 'failed', at: 1, reason: 'x', output: '' })).toBe(false);
    expect(askAgentOf(line({ dismissed: true }), undefined)).toBe(false);
  });
});

describe('askAgentText', () => {
  test('names the step, what needs it, its command, the failure and its output', () => {
    const text = askAgentText(line(), list([line(), mcp]), { state: 'failed', at: 1, reason: 'brew is not installed', output: 'zsh: command not found: brew' }, 'mac');
    expect(text).toContain('(Mac mini, macOS)');
    expect(text).toContain('**Install uv** (section Tools)');
    expect(text).toContain('It is needed by: ha.');
    expect(text).toContain('Kestrel would run `brew install uv`.');
    expect(text).toContain('It failed: "brew is not installed".');
    expect(text).toContain('```\nzsh: command not found: brew\n```');
    expect(text).toContain('`setup_list`');
  });

  test('without a failure it says the state; a value typed on a line is never in it', () => {
    expect(askAgentText(mcp, list([line(), mcp]), undefined, 'linux')).toContain('It is waiting on: Install uv.');
    expect(askAgentText(line(), list([line()]), { state: 'waiting', at: 1, on: 'you' }, 'mac')).not.toContain('glpat');
  });
});

describe('setupListText', () => {
  test('lists every line with its state and needs, and no run output', () => {
    const text = setupListText(list([line(), mcp]), { 'tool:uv': { state: 'failed', at: 1, reason: 'no brew', output: 'SECRET-OUTPUT' } });
    expect(text).toContain('- tool:uv | Install uv | failed: no brew | runs: user');
    expect(text).toContain('Needs: tool:uv.');
    expect(text).not.toContain('SECRET-OUTPUT');
  });
});

describe('adminCommandRefusal', () => {
  test.each([
    [['sudo', 'apt', 'install', 'x']],
    [['/usr/bin/sudo', 'x']],
    [['env', 'A=1', 'sudo', 'x']],
    [['nice', '-n', '5', 'doas', 'x']],
    [['pkexec', 'x']],
    [['su', '-c', 'x']],
    [['runas', '/user:Administrator', 'x']],
    [['gsudo.exe', 'x']],
    [['osascript', '-e', 'do shell script "x" with administrator privileges']],
    [['bash', '-c', 'apt update && sudo apt install x']],
    [['powershell', '-Command', 'Start-Process x -Verb RunAs']],
  ])('refuses %j', (argv) => {
    expect(adminCommandRefusal(argv)).toMatch(/paste into their terminal instead/);
  });

  test('lets a user-level command through', () => {
    expect(adminCommandRefusal(['brew', 'install', 'uv'])).toBeNull();
    expect(adminCommandRefusal(['npm', 'install', '-g', 'pnpm'])).toBeNull();
    expect(adminCommandRefusal(['bash', '-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh'])).toBeNull();
    expect(adminCommandRefusal([])).toMatch(/list of words/);
  });

  test('the card shows the command quoted for the shell', () => {
    expect(cardCommandText(['git', 'config', '--global', 'user.name', 'Octo Cat'], 'mac')).toBe("git config --global user.name 'Octo Cat'");
  });
});
