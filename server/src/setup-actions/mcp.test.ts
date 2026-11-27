import { describe, expect, test } from 'vitest';
import { memoryPersistence } from '../persistence/memory.ts';
import { memorySecrets } from '../mcp-servers/secrets.ts';
import { McpServerStore } from '../mcp-servers/store.ts';
import type { SetupMcpServer } from '../shared/setup-record.ts';
import { mcpInputOf, mcpStateOf, mcpTarget } from './mcp.ts';

const HOME = '/home/someone';

const stdio = (over: Partial<SetupMcpServer> = {}): SetupMcpServer => ({ name: 'notes', scope: 'user', transport: 'stdio', command: 'uvx', args: ['notes-mcp', '--dir', '~/Notes'], url: null, env: ['NOTES_TOKEN'], headers: [], blanks: [{ kind: 'env', name: 'NOTES_TOKEN' }], appProgram: null, ...over });

describe('mcpInputOf', () => {
  test('a local command keeps its program, makes ~/ paths this home, and turns every variable into an empty secret', () => {
    expect(mcpInputOf(stdio(), HOME)).toEqual({ name: 'notes', kind: 'stdio', command: 'uvx', args: ['notes-mcp', '--dir', '/home/someone/Notes'], env: [{ key: 'NOTES_TOKEN', secret: true }], headers: [], projectId: null });
  });

  test('an address keeps its URL and turns every header into an empty secret', () => {
    const http = stdio({ transport: 'http', command: null, args: [], url: 'https://example.com/mcp', env: [], headers: ['Authorization'], blanks: [{ kind: 'header', name: 'Authorization' }] });
    expect(mcpInputOf(http, HOME)).toMatchObject({ kind: 'http', url: 'https://example.com/mcp', headers: [{ key: 'Authorization', secret: true }] });
  });

  test('an argument left out because it looked like a key is refused with where to add it', () => {
    expect(() => mcpInputOf(stdio({ args: ['run', null], blanks: [{ kind: 'argument', name: '2' }] }), HOME)).toThrow(/argument 2.*Settings → Agent setup → MCP servers/);
  });

  test('a path that climbs out of the home folder is refused', () => {
    expect(() => mcpInputOf(stdio({ command: '~/../other/bin/x' }), HOME)).toThrow(/outside the home folder/);
    expect(() => mcpInputOf(stdio({ args: ['~/../../etc'] }), HOME)).toThrow(/outside the home folder/);
  });
});

describe('mcpTarget', () => {
  test('adds the server with nothing set, says which values to enter, and Undo removes it', async () => {
    const store = new McpServerStore(memoryPersistence(), memorySecrets());
    const added = await mcpTarget(store).add(stdio(), HOME);
    expect(added.said).toBe("Added to Kestrel's MCP servers, without its values. It still needs NOTES_TOKEN: copy them from a computer that has them, or enter them on its page.");
    const view = (await store.list()).servers.find((s) => s.name === 'notes');
    expect(view?.env).toEqual([{ key: 'NOTES_TOKEN', secret: true, set: false }]);
    expect(mcpStateOf(view)).toBe('needs-values');
    await added.undo();
    expect((await store.list()).servers).toEqual([]);
  });

  test('refuses a server of the same name, and leaves the one there alone', async () => {
    const store = new McpServerStore(memoryPersistence(), memorySecrets());
    await store.save(null, { name: 'notes', kind: 'stdio', command: 'other', args: [], env: [], headers: [], projectId: null });
    await expect(mcpTarget(store).add(stdio(), HOME)).rejects.toThrow(/already an MCP server named notes/);
    expect((await store.list()).servers[0]?.command).toBe('other');
  });

  test('a server with every value set is ready; one not in the list is missing', () => {
    expect(mcpStateOf(undefined)).toBe('missing');
    expect(mcpStateOf({ name: 'x', kind: 'stdio', env: [{ key: 'A', secret: true, set: true }], headers: [], projectId: null, where: 'x' })).toBe('ready');
  });
});
