// Settings' Test, against a real server over stdio, and the routes: no answer carries a secret value.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { memoryPersistence } from '../persistence/memory.ts';
import { mcpServersRoute } from './api.ts';
import { blankValues, probeServer } from './probe.ts';
import { memorySecrets, sealedSecrets } from './secrets.ts';
import { McpServerStore } from './store.ts';

const fixture = fileURLToPath(new URL('./fixtures/echo-server.mjs', import.meta.url));

describe('probeServer', () => {
  test('starts a local server once and lists its tools', async () => {
    expect(await probeServer({ command: process.execPath, args: [fixture], env: { ECHO_KEY: 'right-key' } })).toEqual({ ok: true, tools: [{ name: 'echo', description: 'Says it back' }] });
  });

  test('a failure is said with every value blanked out', async () => {
    const result = await probeServer({ command: process.execPath, args: [fixture], env: { ECHO_KEY: 'wrong-key-123' } }, 5000);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('bad key: ••••');
    expect(result.error).not.toContain('wrong-key-123');
  });

  test('blankValues leaves short values alone', () => {
    expect(blankValues('token abcd and ab', ['abcd', 'ab'])).toBe('token •••• and ab');
  });
});

describe('the sealed file', () => {
  test('holds no value in clear, and opens again with the key', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'kestrel-mcp-')), 'mcp-servers.sealed');
    const key = Buffer.alloc(32, 7);
    await sealedSecrets(path, key).write({ n8n: { 'header:Authorization': 'Bearer n8n_live_9f8e' } });
    expect(readFileSync(path).toString('latin1')).not.toContain('n8n_live_9f8e');
    expect(await sealedSecrets(path, key).read()).toEqual({ n8n: { 'header:Authorization': 'Bearer n8n_live_9f8e' } });
    expect(await sealedSecrets(path, Buffer.alloc(32, 8)).read()).toEqual({});
  });
});

describe('the routes', () => {
  const TOKEN = 'n8n_live_9f8e7d6c5b4a';
  const setUp = () => {
    const store = new McpServerStore(memoryPersistence(), memorySecrets());
    const probed: Record<string, unknown>[] = [];
    const api = { store, probe: async (config: Record<string, unknown>) => (probed.push(config), { ok: true as const, tools: [] }) };
    const ask = (method: string, path: string, body: object = {}) => mcpServersRoute(['api', ...path.split('/').filter(Boolean)], method, async () => body as Record<string, unknown>, api);
    return { ask, probed };
  };

  test('no answer carries a secret value; Test is given it', async () => {
    const { ask, probed } = setUp();
    const added = await ask('POST', 'mcp-servers', { name: 'n8n', kind: 'http', url: 'https://n8n.example.com/mcp', headers: [{ key: 'Authorization', value: `Bearer ${TOKEN}` }] });
    expect(added?.status).toBe(201);
    for (const answer of [added, await ask('GET', 'mcp-servers'), await ask('GET', 'mcp-servers/n8n'), await ask('PUT', 'mcp-servers/n8n', { name: 'n8n', kind: 'http', url: 'https://n8n.example.com/mcp', headers: [{ key: 'Authorization' }] })]) {
      expect(JSON.stringify(answer)).not.toContain(TOKEN);
    }
    expect((await ask('POST', 'mcp-servers/n8n/test'))?.body).toEqual({ ok: true, tools: [] });
    expect(probed[0]).toMatchObject({ headers: { Authorization: `Bearer ${TOKEN}` } });
    expect((await ask('DELETE', 'mcp-servers/n8n'))?.status).toBe(204);
    await expect(ask('GET', 'mcp-servers/n8n')).rejects.toThrow(/No MCP server named n8n/);
  });

  test('not its route: null', async () => {
    const { ask } = setUp();
    expect(await ask('GET', 'setup')).toBeNull();
  });
});
