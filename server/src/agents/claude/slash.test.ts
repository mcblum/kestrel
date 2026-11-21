import { describe, expect, it } from 'vitest';
import { askSlashCommands, claudeSlashCommands, leftOut, NOT_IN_KESTREL, terminalOnlyOf } from './slash.ts';

describe('asking Claude for its slash commands', () => {
  it('keeps what it lists, without the ones the init message marks as terminal-only', async () => {
    const q = { supportedCommands: async () => [{ name: 'compact', description: 'Compact', argumentHint: '' }, { name: 'doctor', description: 'Check' }, { name: 'ship', description: 'Ship it', argumentHint: '<pr>' }] };
    const terminal = terminalOnlyOf({ terminal_slash_commands: ['doctor', 7] });
    expect(terminal).toEqual(['doctor']);
    expect(await askSlashCommands(q as never, terminal)).toEqual([{ name: 'compact', description: 'Compact' }, { name: 'ship', description: 'Ship it', argumentHint: '<pr>' }]);
  });

  it('can be asked without running a turn: a query that sends nothing, closed afterwards, with the known terminal-only ones left out', async () => {
    let closed = false;
    let seen: { prompt: unknown; options: Record<string, unknown> } | null = null;
    const runQuery = ((args: { prompt: unknown; options: Record<string, unknown> }) => {
      seen = args;
      return { supportedCommands: async () => [{ name: 'compact', description: 'Compact' }, { name: 'doctor', description: 'Check' }], close: () => (closed = true) };
    }) as never;
    const options = { directory: '/w', instruction: '', permission: 'ask', tools: {}, setup: { loadSettings: true, inProject: true, mcpServers: { github: {} } } } as never;
    expect(await claudeSlashCommands(options, runQuery)).toEqual([{ name: 'compact', description: 'Compact' }]);
    expect(closed).toBe(true);
    // The session's own settings (so its skills are listed), and nothing that could act: no MCP servers, no hooks.
    expect(seen!.options).toMatchObject({ cwd: '/w', settingSources: ['user', 'project', 'local'], mcpServers: {}, settings: { disableAllHooks: true } });
  });

  it('leaves out the commands that make no sense inside Kestrel, in a running session and when asked without a turn', async () => {
    const listed = ['compact', 'model', 'effort', 'fast', 'rename', 'clear', 'mcp', 'config', 'heapdump', 'agents', 'extra-usage', '__remote-workflow', 'workflow-launch-exec', 'usage', 'my-skill'].map((name) => ({ name, description: name }));
    const kept = ['compact', 'usage', 'my-skill'];
    // A running session: the init message's terminal-only names, and Kestrel's own list.
    expect((await askSlashCommands({ supportedCommands: async () => listed } as never, leftOut(['usage'])))!.map((c) => c.name)).toEqual(['compact', 'my-skill']);
    const runQuery = (() => ({ supportedCommands: async () => listed, close: () => undefined })) as never;
    expect((await claudeSlashCommands({ directory: '/w', instruction: '', permission: 'ask', tools: {} } as never, runQuery))!.map((c) => c.name)).toEqual(kept);
    // Every one that is left out says why.
    for (const why of Object.values(NOT_IN_KESTREL)) expect(why.length).toBeGreaterThan(10);
    expect(leftOut(['doctor', 'model'])).toEqual(['doctor', ...Object.keys(NOT_IN_KESTREL)]);
  });

  it('says nothing when the query cannot answer, fails, or takes too long', async () => {
    expect(await askSlashCommands(null, [])).toBeNull();
    expect(await askSlashCommands({} as never, [])).toBeNull();
    expect(await askSlashCommands({ supportedCommands: async () => Promise.reject(new Error('closed')) } as never, [])).toBeNull();
    expect(await askSlashCommands({ supportedCommands: () => new Promise(() => undefined) } as never, [], 20)).toBeNull();
    expect(terminalOnlyOf({})).toEqual([]);
  });
});
