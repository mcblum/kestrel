// What each agent is handed of Kestrel's MCP servers, and what each says of them for the header.
import { describe, expect, test } from 'vitest';
import { claudeServerStates } from '../agents/claude/map.ts';
import { threadConfig } from '../agents/codex/config.ts';
import { codexServerStates } from '../agents/codex/servers.ts';
import { processConfig } from '../agents/opencode/config.ts';
import { opencodeServerStates } from '../agents/opencode/started.ts';
import { mergeServers, parseServerInput } from '../shared/mcp-servers.ts';

const TOKEN = 'n8n_live_9f8e7d6c5b4a';
const def = (raw: object) => parseServerInput(raw, []).def;
const http = def({ name: 'n8n', kind: 'http', url: 'https://n8n.example.com/mcp', headers: [{ key: 'Authorization' }] });
const sse = def({ name: 'feeds', kind: 'sse', url: 'https://feeds.example/sse', headers: [{ key: 'X-Key' }] });
const local = def({ name: 'notes', kind: 'stdio', command: 'notes-mcp', args: ['--dir', '/n'], env: [{ key: 'NOTES_KEY' }] });
const secrets = { n8n: { 'header:Authorization': `Bearer ${TOKEN}` }, feeds: { 'header:X-Key': 'feeds-key-1' }, notes: { 'env:NOTES_KEY': 'notes-key-1' } };
// The user's own Codex/OpenCode file also defines a server called n8n: Kestrel's wins.
const merged = mergeServers({ n8n: { command: 'old-n8n' } }, [http, sse, local], secrets);
const setup = { loadSettings: true, inProject: true, mcpServers: merged.mcpServers, kestrelServers: merged.handed };

describe('Claude', () => {
  test('is handed every kind in its SDK options, values in each server’s own entry', () => {
    expect(setup.mcpServers).toEqual({
      n8n: { type: 'http', url: 'https://n8n.example.com/mcp', headers: { Authorization: `Bearer ${TOKEN}` } },
      feeds: { type: 'sse', url: 'https://feeds.example/sse', headers: { 'X-Key': 'feeds-key-1' } },
      notes: { command: 'notes-mcp', args: ['--dir', '/n'], env: { NOTES_KEY: 'notes-key-1' } },
    });
  });

  test('its init message says which servers connected', () => {
    const init = { type: 'system', subtype: 'init', mcp_servers: [{ name: 'n8n', status: 'connected' }, { name: 'feeds', status: 'needs-auth' }, { name: 'notes', status: 'failed' }, { name: 'kestrel', status: 'connected' }] };
    expect(claudeServerStates(init, merged.handed)).toEqual([
      { name: 'n8n', state: 'connected' },
      { name: 'feeds', state: 'needs-sign-in' },
      { name: 'notes', state: 'failed' },
    ]);
  });
});

describe('Codex', () => {
  const config = threadConfig({ kestrelUrl: null, setup, configuredServers: ['n8n', 'feeds', 'mine'] });

  test('is handed HTTP and local servers, Kestrel’s copy over its own file’s', () => {
    expect(config['mcp_servers.n8n']).toEqual({ url: 'https://n8n.example.com/mcp', http_headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(config['mcp_servers.notes']).toEqual({ command: 'notes-mcp', args: ['--dir', '/n'], env: { NOTES_KEY: 'notes-key-1' } });
    expect(config['mcp_servers.mine.enabled']).toBe(false);
  });

  test('is never handed an SSE server, and its own one of that name is switched off', () => {
    expect(config['mcp_servers.feeds']).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain('feeds-key-1');
    expect(config['mcp_servers.feeds.enabled']).toBe(false);
  });

  test('the header says why it has no SSE server, and what Codex reported of the rest', () => {
    const listed = [
      { name: 'n8n', runtimeStatus: 'connected', tools: {} },
      { name: 'notes', runtimeStatus: 'failed', toolsError: 'spawn notes-mcp ENOENT' },
    ];
    expect(codexServerStates(listed, merged.handed)).toEqual([
      { name: 'n8n', state: 'connected' },
      { name: 'feeds', state: 'not-for-agent', reason: expect.stringMatching(/Codex cannot reach feeds: it speaks only SSE/) },
      { name: 'notes', state: 'failed', reason: 'spawn notes-mcp ENOENT' },
    ]);
  });
});

describe('OpenCode', () => {
  const config = processConfig({ kestrel: null, setup, configuredServers: ['n8n', 'mine'], instructionFile: '/tmp/i.md' }) as { mcp: Record<string, unknown> };

  test('is handed every kind, secrets included (M10)', () => {
    expect(config.mcp.n8n).toEqual({ type: 'remote', url: 'https://n8n.example.com/mcp', enabled: true, headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(config.mcp.feeds).toEqual({ type: 'remote', url: 'https://feeds.example/sse', enabled: true, headers: { 'X-Key': 'feeds-key-1' } });
    expect(config.mcp.notes).toEqual({ type: 'local', command: ['notes-mcp', '--dir', '/n'], enabled: true, environment: { NOTES_KEY: 'notes-key-1' } });
    expect(config.mcp.mine).toEqual({ enabled: false });
  });

  test('the header reads OpenCode’s own status', () => {
    const status = { n8n: { status: 'connected' }, feeds: { status: 'failed', error: 'Connection refused' }, notes: { status: 'needs_auth' }, mine: { status: 'disabled' } };
    expect(opencodeServerStates(status, merged.handed)).toEqual([
      { name: 'n8n', state: 'connected' },
      { name: 'feeds', state: 'failed', reason: 'Connection refused' },
      { name: 'notes', state: 'needs-sign-in' },
    ]);
  });
});
