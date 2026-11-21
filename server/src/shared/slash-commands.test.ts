import { describe, expect, it } from 'vitest';
import { matchSlashCommands, slashCommandsFrom, slashCompletion, slashQuery, SLASH_MENU_MAX } from './slash-commands.ts';

const list = slashCommandsFrom([
  { name: 'compact', description: 'Clear history but keep a summary', argumentHint: '<instructions>' },
  { name: 'context', description: 'Show context usage', argumentHint: '' },
  { name: 'code-review', description: 'Review the current diff' },
  { name: 'doctor', description: 'Check the installation' },
  { name: 'deploy', description: 'Ship to staging and compact the logs' },
]);

describe('the commands an agent lists', () => {
  it('are kept without the terminal-only ones, blanks and repeats, in the agent’s order', () => {
    const kept = slashCommandsFrom([{ name: 'compact', description: 'a', argumentHint: ' <x> ' }, { name: 'doctor', description: 'b' }, { name: '/context', description: 'c' }, { name: 'compact', description: 'again' }, { name: '' }, null, { name: 'two words' }], ['doctor']);
    expect(kept).toEqual([{ name: 'compact', description: 'a', argumentHint: '<x>' }, { name: 'context', description: 'c' }]);
  });
});

describe('typing a command', () => {
  it('is recognised only while nothing but the name has been typed', () => {
    expect(slashQuery('/')).toBe('');
    expect(slashQuery('/Com')).toBe('com');
    expect(slashQuery('/compact ')).toBeNull();
    expect(slashQuery('/compact now')).toBeNull();
    expect(slashQuery('see /compact')).toBeNull();
    expect(slashQuery('/a/b')).toBeNull();
    expect(slashQuery('/x\n')).toBeNull();
    expect(slashQuery('')).toBeNull();
  });

  it('finds names that start with what was typed first, then names that contain it, then descriptions', () => {
    expect(matchSlashCommands(list, 'co').map((c) => c.name)).toEqual(['compact', 'context', 'code-review', 'deploy']); // deploy by its description
    expect(matchSlashCommands(list, 'compact').map((c) => c.name)).toEqual(['compact', 'deploy']);
    expect(matchSlashCommands(list, 'view').map((c) => c.name)).toEqual(['code-review']);
    expect(matchSlashCommands(list, 'zzz')).toEqual([]);
    expect(matchSlashCommands(list, '').map((c) => c.name)).toEqual(['compact', 'context', 'code-review', 'doctor', 'deploy']);
  });

  it('lists a bounded number, and completes to the name and a space', () => {
    const many = slashCommandsFrom(Array.from({ length: 200 }, (_, i) => ({ name: `c${i}`, description: '' })));
    expect(matchSlashCommands(many, '')).toHaveLength(SLASH_MENU_MAX);
    expect(matchSlashCommands(many, 'c1')).toHaveLength(SLASH_MENU_MAX);
    expect(slashCompletion({ name: 'compact' })).toBe('/compact ');
  });
});
