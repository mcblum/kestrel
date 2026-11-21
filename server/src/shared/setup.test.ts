import { describe, expect, it } from 'vitest';
import { DEFAULT_SETUP, discoverMcpServers, enabledServers, publicInfo, sanitizeSetup } from './setup.ts';

const userConfig = {
  mcpServers: {
    notes: { type: 'http', url: 'https://notes.example.com/mcp', headers: { Authorization: 'Bearer SECRET' } },
    memory: { type: 'sse', url: 'https://memory.example.com/sse' },
    shared: { command: '/usr/local/bin/user-shared' },
  },
  projects: {
    '/code/app': { mcpServers: { home: { command: '/opt/tools/home-mcp', args: ['--token', 'SECRET'], env: { KEY: 'SECRET' } }, shared: { command: 'local-shared' } } },
    '/code/other': { mcpServers: { elsewhere: { command: 'x' } } },
  },
};
const projectFile = { mcpServers: { db: { command: 'db-mcp' }, shared: { command: 'project-shared' } } };

describe('the user\'s MCP servers', () => {
  it('finds servers for every project, the project\'s shared file, and this project only', () => {
    const servers = discoverMcpServers('/code/app', { claude: userConfig, projectFile });
    expect(servers.map((s) => `${s.name}:${s.scope}:${s.kind}`)).toEqual(['db:project:stdio', 'home:local:stdio', 'memory:user:sse', 'notes:user:http', 'shared:local:stdio']);
  });
  it('the narrowest definition of a name wins', () => {
    expect(discoverMcpServers('/code/app', { claude: userConfig, projectFile }).find((s) => s.name === 'shared')!.where).toBe('local-shared');
    expect(discoverMcpServers('/code/app', { claude: userConfig }).find((s) => s.name === 'shared')!.where).toBe('local-shared');
    expect(discoverMcpServers('/code/unknown', { claude: userConfig, projectFile }).find((s) => s.name === 'shared')!.where).toBe('project-shared');
  });
  it('a session with no project sees only the servers set up for every project', () => {
    expect(discoverMcpServers(null, { claude: userConfig, projectFile }).map((s) => s.name)).toEqual(['memory', 'notes', 'shared']);
  });
  it('tells the UI what a server is without its arguments, headers or environment', () => {
    const shown = JSON.stringify(discoverMcpServers('/code/app', { claude: userConfig, projectFile }).map(publicInfo));
    expect(shown).not.toContain('SECRET');
    expect(shown).toContain('notes.example.com');
    expect(shown).toContain('home-mcp');
  });
  it('includes the Claude desktop app\'s servers, which rank below Claude Code\'s own', () => {
    const desktop = { mcpServers: { 'Home Assistant': { command: '/usr/local/bin/ha-mcp', env: { TOKEN: 'SECRET' } }, memory: { command: 'desktop-memory' } } };
    const servers = discoverMcpServers('/code/app', { claude: userConfig, projectFile, desktop });
    expect(servers.find((s) => s.name === 'Home Assistant')).toMatchObject({ scope: 'desktop', kind: 'stdio', where: 'ha-mcp' });
    expect(servers.find((s) => s.name === 'memory')).toMatchObject({ scope: 'user', kind: 'sse' });
    expect(discoverMcpServers(null, { claude: userConfig, desktop }).map((s) => s.name)).toContain('Home Assistant');
    expect(JSON.stringify(servers.map(publicInfo))).not.toContain('SECRET');
  });
  it('reads Codex servers too, in the shape Claude takes', () => {
    const codex = { mcp_servers: { repl: { command: '/opt/codex/node_repl', args: ['--stdio'], env: { K: 'SECRET' } }, docs: { url: 'https://docs.example.com/mcp', http_headers: { A: 'SECRET' } }, off: { command: 'x', enabled: false } } };
    const servers = discoverMcpServers(null, { codex });
    expect(servers.map((s) => `${s.name}:${s.scope}:${s.kind}:${s.where}`)).toEqual(['docs:codex:http:docs.example.com', 'repl:codex:stdio:node_repl']);
    expect(servers.find((s) => s.name === 'repl')!.config).toEqual({ command: '/opt/codex/node_repl', args: ['--stdio'], env: { K: 'SECRET' } });
    expect(servers.find((s) => s.name === 'docs')!.config).toEqual({ type: 'http', url: 'https://docs.example.com/mcp', headers: { A: 'SECRET' } });
    expect(JSON.stringify(servers.map(publicInfo))).not.toContain('SECRET');
  });
  it("reads OpenCode's servers in its own words: the command as one array, `environment`, `remote`", () => {
    const opencode = { mcp: { ha: { type: 'local', command: ['/usr/bin/ha-mcp', '--stdio'], environment: { TOKEN: 'SECRET' } }, web: { type: 'remote', url: 'https://web.example.com/mcp', headers: { A: 'SECRET' } }, off: { type: 'local', command: ['x'], enabled: false } } };
    const servers = discoverMcpServers(null, { opencode });
    expect(servers.map((s) => `${s.name}:${s.scope}:${s.kind}:${s.where}`)).toEqual(['ha:opencode:stdio:ha-mcp', 'web:opencode:http:web.example.com']);
    expect(servers.find((s) => s.name === 'ha')!.config).toEqual({ command: '/usr/bin/ha-mcp', args: ['--stdio'], env: { TOKEN: 'SECRET' } });
    expect(JSON.stringify(servers.map(publicInfo))).not.toContain('SECRET');
  });
  it('Claude Code\'s own definition of a name wins over another tool\'s', () => {
    const servers = discoverMcpServers(null, { claude: userConfig, codex: { mcp_servers: { notes: { command: 'codex-notes' } } } });
    expect(servers.find((s) => s.name === 'notes')).toMatchObject({ scope: 'user', kind: 'http' });
  });
  it('copes with missing or malformed files', () => {
    expect(discoverMcpServers('/code/app', { claude: null, projectFile: 'nonsense' })).toEqual([]);
    expect(discoverMcpServers('/code/app', { claude: { mcpServers: { broken: 5, empty: {} } } })).toEqual([]);
  });
});

describe('what a project switches on', () => {
  it('loads the user\'s settings by default and no MCP servers', () => {
    expect(DEFAULT_SETUP).toEqual({ loadSettings: true, mcpServers: [] });
    expect(sanitizeSetup(null)).toEqual(DEFAULT_SETUP);
    expect(sanitizeSetup({ loadSettings: false, mcpServers: ['a', 'a', 3] })).toEqual({ loadSettings: false, mcpServers: ['a'] });
  });
  it('starts a session with only the servers switched on, with their full configuration', () => {
    const discovered = discoverMcpServers('/code/app', { claude: userConfig, projectFile });
    const enabled = enabledServers({ loadSettings: true, mcpServers: ['notes', 'gone'] }, discovered);
    expect(Object.keys(enabled)).toEqual(['notes']);
    expect(enabled.notes).toEqual(userConfig.mcpServers.notes);
    expect(enabledServers(DEFAULT_SETUP, discovered)).toEqual({});
  });
});
