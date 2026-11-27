import { describe, expect, test } from 'vitest';
import { codexCannot, switchableServers, kestrelServersFor, mergeServers, missingValues, nextSecrets, parseServerInput, serverConfig, serverStates, serverStateText, serverView, slotOf, type McpServerDef } from './mcp-servers.ts';

const TOKEN = 'n8n_live_9f8e7d6c5b4a';

const n8n = (over: object = {}) => ({ name: 'n8n', kind: 'http', url: 'https://n8n.example.com/mcp', headers: [{ key: 'Authorization', value: `Bearer ${TOKEN}` }], ...over });

describe('parseServerInput: what was typed, checked and split', () => {
  test('a secret value is split off the definition', () => {
    const { def, typed } = parseServerInput(n8n(), []);
    expect(def).toEqual({ name: 'n8n', kind: 'http', url: 'https://n8n.example.com/mcp', env: [], headers: [{ key: 'Authorization', secret: true }], projectId: null });
    expect(JSON.stringify(def)).not.toContain(TOKEN);
    expect(typed).toEqual({ [slotOf('header', 'Authorization')]: `Bearer ${TOKEN}` });
  });

  test('a value marked not secret stays in the definition', () => {
    const { def, typed } = parseServerInput({ name: 'notes', kind: 'stdio', command: 'npx', args: ['-y', 'notes-mcp', ''], env: [{ key: 'NOTES_DIR', value: '/tmp/notes', secret: false }, { key: 'NOTES_KEY', value: 'k-1234' }] }, []);
    expect(def.args).toEqual(['-y', 'notes-mcp']);
    expect(def.env).toEqual([{ key: 'NOTES_DIR', secret: false, value: '/tmp/notes' }, { key: 'NOTES_KEY', secret: true }]);
    expect(typed).toEqual({ 'env:NOTES_KEY': 'k-1234' });
  });

  test('a secret left empty keeps what is stored; one cleared is dropped', () => {
    const { def, typed, cleared } = parseServerInput(n8n({ headers: [{ key: 'Authorization' }, { key: 'X-Team', clear: true }] }), []);
    expect(typed).toEqual({});
    expect(cleared).toEqual(['header:X-Team']);
    expect(nextSecrets(def, { 'header:Authorization': 'old', 'header:X-Team': 'blue', 'header:Gone': 'x' }, typed, cleared)).toEqual({ 'header:Authorization': 'old' });
  });

  test('a value typed replaces the stored one', () => {
    const { def, typed, cleared } = parseServerInput(n8n(), []);
    expect(nextSecrets(def, { 'header:Authorization': 'old' }, typed, cleared)).toEqual({ 'header:Authorization': `Bearer ${TOKEN}` });
  });

  test.each([
    [{ name: 'has space', kind: 'stdio', command: 'x' }, /1 to 64 letters/],
    [{ name: 'kestrel', kind: 'stdio', command: 'x' }, /Kestrel's own tools/],
    [{ name: 'a', kind: 'ws', command: 'x' }, /local command, HTTP or SSE/],
    [{ name: 'a', kind: 'stdio', command: ' ' }, /needs the command/],
    [{ name: 'a', kind: 'http', url: 'n8n.local' }, /full URL/],
    [{ name: 'a', kind: 'http', url: 'ftp://x/y' }, /https:\/\//],
    [{ name: 'a', kind: 'http', url: 'https://me:pw@x/mcp' }, /secret header/],
    [{ name: 'a', kind: 'http', url: 'https://x/mcp', env: [{ key: 'A', value: '1' }] }, /headers, not environment/],
    [{ name: 'a', kind: 'stdio', command: 'x', headers: [{ key: 'A', value: '1' }] }, /environment variables, not headers/],
    [{ name: 'a', kind: 'stdio', command: 'x', env: [{ key: '1A', value: '1' }] }, /environment variable name/],
    [{ name: 'a', kind: 'http', url: 'https://x/mcp', headers: [{ key: 'A', value: '1' }, { key: 'a', value: '2' }] }, /given twice/],
    [{ name: 'a', kind: 'stdio', command: 'x', projectId: 'nope' }, /No such project/],
  ])('refused with the reason: %j', (raw, reason) => {
    expect(() => parseServerInput(raw, ['p1'])).toThrow(reason);
  });
});

describe('serverView: what may be shown', () => {
  test('never a secret value: only whether it is set', () => {
    const { def } = parseServerInput(n8n(), []);
    const view = serverView(def, { 'header:Authorization': `Bearer ${TOKEN}` });
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    expect(view.headers).toEqual([{ key: 'Authorization', secret: true, set: true }]);
    expect(serverView(def, {}).headers[0]!.set).toBe(false);
    expect(view.where).toBe('n8n.example.com');
  });

  test('an SSE server says Codex cannot reach it, and why', () => {
    const { def } = parseServerInput(n8n({ kind: 'sse' }), []);
    expect(serverView(def).cannot?.codex).toMatch(/Codex cannot reach n8n: it speaks only SSE/);
    expect(serverView(parseServerInput(n8n(), []).def).cannot).toBeUndefined();
  });
});

describe('serverConfig: values go into the server’s own entry only', () => {
  test('a local command gets its environment; a value with none is left out', () => {
    const { def } = parseServerInput({ name: 'notes', kind: 'stdio', command: 'notes-mcp', env: [{ key: 'DIR', value: '/n', secret: false }, { key: 'KEY' }, { key: 'OTHER' }] }, []);
    expect(serverConfig(def, { 'env:KEY': 's3cret' })).toEqual({ command: 'notes-mcp', args: [], env: { DIR: '/n', KEY: 's3cret' } });
    expect(missingValues(def, { 'env:KEY': 's3cret' })).toEqual(['OTHER']);
  });

  test('an address gets its headers, and its kind', () => {
    const { def } = parseServerInput(n8n({ kind: 'sse' }), []);
    expect(serverConfig(def, { 'header:Authorization': 'Bearer t' })).toEqual({ type: 'sse', url: 'https://n8n.example.com/mcp', headers: { Authorization: 'Bearer t' } });
  });
});

describe('which of Kestrel’s servers a session gets', () => {
  const every = (name: string): McpServerDef => ({ name, kind: 'http', url: `https://${name}.example/mcp`, env: [], headers: [], projectId: null });
  const own = (name: string, projectId: string): McpServerDef => ({ ...every(name), projectId });
  const defs = [every('n8n'), every('jira'), own('wren-db', 'wren'), own('other-db', 'other')];

  test('in a project: the defaults it has on, and its own', () => {
    expect(kestrelServersFor(defs, ['n8n'], 'wren').map((d) => d.name)).toEqual(['n8n', 'wren-db']);
  });

  test('the default set alone: no project, or a review', () => {
    expect(kestrelServersFor(defs, ['n8n', 'jira'], null).map((d) => d.name)).toEqual(['n8n', 'jira']);
  });

  test('Kestrel’s wins over a server of the same name found in an agent’s file', () => {
    const merged = mergeServers({ n8n: { command: 'old-n8n' }, notes: { command: 'notes' } }, [every('n8n')], { n8n: {} });
    expect(merged.mcpServers).toEqual({ n8n: { type: 'http', url: 'https://n8n.example/mcp' }, notes: { command: 'notes' } });
    expect(merged.handed).toEqual([{ name: 'n8n', kind: 'http', missing: [] }]);
  });
});

describe('serverStates: the header, honestly', () => {
  const handed = [
    { name: 'n8n', kind: 'sse' as const, missing: [] },
    { name: 'jira', kind: 'http' as const, missing: ['Authorization'] },
  ];

  test('Codex was never handed an SSE server and says so', () => {
    const states = serverStates(handed, 'codex', new Map([['jira', { state: 'failed', reason: '401' }]]));
    expect(states[0]).toEqual({ name: 'n8n', state: 'not-for-agent', reason: codexCannot({ name: 'n8n', kind: 'sse' }) });
    expect(states[1]).toEqual({ name: 'jira', state: 'failed', reason: '401', missing: ['Authorization'] });
    expect(serverStateText(states[1]!)).toBe('jira: failed: 401 (needs Authorization on this computer)');
  });

  test('Claude and OpenCode are handed it; unreported reads as unknown', () => {
    expect(serverStates(handed, 'claude', new Map([['n8n', { state: 'connected' }]]))[0]).toEqual({ name: 'n8n', state: 'connected' });
    expect(serverStates(handed, 'opencode', new Map())[0]!.state).toBe('unknown');
  });
});

describe('switchableServers', () => {
  test('Kestrel’s for every project first; a found one of the same name is hidden; a project’s own is not switched', () => {
    const found = [{ name: 'n8n', scope: 'user' as const, kind: 'stdio' as const, where: 'n8n' }, { name: 'notes', scope: 'codex' as const, kind: 'stdio' as const, where: 'notes' }];
    const defs: McpServerDef[] = [{ name: 'n8n', kind: 'http', url: 'https://n8n.example/mcp', env: [], headers: [], projectId: null }, { name: 'db', kind: 'stdio', command: 'db', args: [], env: [], headers: [], projectId: 'p1' }];
    expect(switchableServers(found, defs)).toEqual([{ name: 'n8n', scope: 'kestrel', kind: 'http', where: 'n8n.example' }, { name: 'notes', scope: 'codex', kind: 'stdio', where: 'notes' }]);
  });
});

describe('the name a server from another computer gets in the list', () => {
  test('keeps an allowed name and makes any other one allowed', async () => {
    const { listNameOf } = await import('./mcp-servers.ts');
    expect(listNameOf('home-assistant')).toBe('home-assistant');
    expect(listNameOf('Home Assistant')).toBe('Home-Assistant');
    expect(listNameOf('  n8n (work) / prod  ')).toBe('n8n-work-prod');
    expect(listNameOf('Kestrel')).toBe('Kestrel-mcp');
    expect(listNameOf('new')).toBe('new-mcp');
    expect(listNameOf('***')).toBe('server');
    expect(listNameOf(`${'a'.repeat(63)} b`)).toBe('a'.repeat(63));
  });
});
