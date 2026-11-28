import { describe, expect, test } from 'vitest';
import { NODE_GROUP_COMMAND_NAMES, TOP_COMMAND_NAMES } from '../shared/node-commands.ts';
import { commandHelpText, nodeUsageText, overviewText, usageText } from './help.ts';

/** The command words of a listing: its lines that start with two spaces and a word. */
const listed = (text: string): string[] => text.split('\n').filter((l) => /^ {2}\S/.test(l)).map((l) => l.trim().split(/\s+/)[0]!);

describe('kestrel’s help', () => {
  test('the overview: what it is, the status line, kestrel’s own commands, then the node group’s', () => {
    const text = overviewText('Worker node 1 (Kestrel 0.0.35): set up.');
    const lines = text.split('\n');
    expect(lines.slice(0, 4)).toEqual(['Kestrel', 'Worker node 1 (Kestrel 0.0.35): set up.', '', 'Usage: kestrel <command>']);
    expect(listed(text)).toEqual([...TOP_COMMAND_NAMES, ...NODE_GROUP_COMMAND_NAMES, 'run']);
    expect(TOP_COMMAND_NAMES).toEqual(['node', 'upgrade', 'version', 'help']);
    expect(lines).toContain('Worker node commands (kestrel node <command>):');
    expect(lines).toContain('  upgrade    Install the newest version of this node’s channel (or the version given), as the install command does.');
    expect(lines).toContain('  configure  Set this node up, one step at a time: what needs an administrator, your account, the agents and git.');
  });

  test('kestrel node lists the group’s commands, configure first, with run and help after them', () => {
    const text = nodeUsageText();
    expect(text.split('\n')[0]).toBe('Usage: kestrel node <command>');
    expect(listed(text)).toEqual([...NODE_GROUP_COMMAND_NAMES, 'run', 'help']);
    expect(listed(text)[0]).toBe('configure');
    expect(commandHelpText('node')).toBe(text);
  });

  test('every command has its own help, with how it is typed in full', () => {
    for (const command of NODE_GROUP_COMMAND_NAMES) expect(commandHelpText(command)).toMatch(new RegExp(`^Usage: kestrel node ${command}`));
    expect(commandHelpText('run')).toMatch(/^Usage: kestrel node run\n/);
    expect(commandHelpText('agents')).toContain('Usage: kestrel node agents [claude|codex|opencode] [--yes] [--check]');
    expect(commandHelpText('upgrade')).toMatch(/^Usage: kestrel upgrade \[version\]\n/);
    expect(commandHelpText('upgrade')).toContain('checksum is checked before anything is unpacked');
    expect(commandHelpText('version')).toMatch(/^Usage: kestrel version\n/);
  });

  test('the usage names kestrel, never only the old name, and never a node command without its group', () => {
    for (const text of [usageText(), nodeUsageText(), ...NODE_GROUP_COMMAND_NAMES.map(commandHelpText)]) {
      expect(text).not.toContain('kestrel-node');
      expect(text).not.toMatch(/kestrel (setup|configure|status|join|agents|git|start|stop|logs|uninstall|run)\b/);
    }
  });
});
