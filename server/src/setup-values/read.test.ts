// The one reader of a value for another computer (onboarding.md 19.5): exactly the named values, from the
// place 19.2 names, and never a word of a file in what it says when it fails.
import { describe, expect, it } from 'vitest';
import type { DiscoveredServer } from '../shared/setup.ts';
import type { SetupRecord } from '../shared/setup-record.ts';
import { ReadFailed, readValues, sourceText, type ValueSources } from './read.ts';

const SECRET = 'tok-SECRET-91bd';
const own: Pick<SetupRecord, 'mcp' | 'files'> = {
  mcp: [
    { name: 'home-assistant', scope: 'user', transport: 'stdio', command: 'uvx', args: [], url: null, env: ['HOMEASSISTANT_URL', 'HOMEASSISTANT_TOKEN'], headers: [], blanks: [], appProgram: null },
    { name: 'jira', scope: 'codex', transport: 'http', command: null, args: [], url: 'https://jira.example.com', env: [], headers: ['Authorization'], blanks: [], appProgram: null },
  ],
  files: [],
};

const servers: DiscoveredServer[] = [
  { name: 'home-assistant', scope: 'user', kind: 'stdio', where: 'uvx', config: { command: 'uvx', env: { HOMEASSISTANT_TOKEN: SECRET, HOMEASSISTANT_URL: '', OTHER: 'not asked' } } },
  // The same name in a scope the record does not have is not read.
  { name: 'home-assistant', scope: 'desktop', kind: 'stdio', where: 'uvx', config: { command: 'uvx', env: { HOMEASSISTANT_URL: 'wrong-scope' } } },
  { name: 'jira', scope: 'codex', kind: 'http', where: 'jira.example.com', config: { type: 'http', url: 'https://jira.example.com', headers: { Authorization: `Bearer ${SECRET}` } } },
];

const sources = (over: Partial<ValueSources> = {}): ValueSources => ({ home: '/home/me', mcpServers: () => servers, readText: () => JSON.stringify({ env: { MY_TOKEN: SECRET, OTHER: 'x' }, permissions: { allow: [] } }), ...over });

describe('reading the values asked for', () => {
  it("takes an MCP server's environment values from the scope the record names, and says which are not there", async () => {
    expect(await readValues(sources(), 'mcp:home-assistant', ['HOMEASSISTANT_URL', 'HOMEASSISTANT_TOKEN'], own)).toEqual({ values: { HOMEASSISTANT_TOKEN: SECRET }, notThere: ['HOMEASSISTANT_URL'] });
  });

  it('takes a header, and a name still missing from Kestrel’s own list', async () => {
    expect(await readValues(sources(), 'mcp:jira', ['Authorization'], own)).toEqual({ values: { Authorization: `Bearer ${SECRET}` }, notThere: [] });
    const withOwn = sources({ kestrelServer: async () => ({ env: { HOMEASSISTANT_URL: 'http://ha.local' } }) });
    expect((await readValues(withOwn, 'mcp:home-assistant', ['HOMEASSISTANT_URL'], own)).values).toEqual({ HOMEASSISTANT_URL: 'http://ha.local' });
  });

  it("takes a settings file's env values and nothing else of it", async () => {
    expect(await readValues(sources(), 'file:~/.claude/settings.json', ['MY_TOKEN', 'MISSING'], own)).toEqual({ values: { MY_TOKEN: SECRET }, notThere: ['MISSING'] });
  });

  it('fails in fixed words that hold nothing of the file', async () => {
    const broken = sources({ readText: () => `{"env": {"MY_TOKEN": "${SECRET}", oops` });
    const error = await readValues(broken, 'file:~/.claude/settings.json', ['MY_TOKEN'], own).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReadFailed);
    expect((error as Error).message).toBe('~/.claude/settings.json could not be read.');
    expect(String((error as Error).stack)).not.toContain(SECRET);
    await expect(readValues(sources(), 'file:/etc/passwd', ['X'], own)).rejects.toThrow('/etc/passwd is not in the home folder.');
    const throwing = sources({ mcpServers: () => { throw new Error(`parse error near "${SECRET}"`); } });
    const second = await readValues(throwing, 'mcp:home-assistant', ['HOMEASSISTANT_TOKEN'], own).catch((e: unknown) => e);
    expect((second as Error).message).toBe('Its MCP servers could not be read.');
    await expect(readValues(sources(), 'agent:claude', ['X'], own)).rejects.toBeInstanceOf(ReadFailed);
  });

  it('says where it would read from', () => {
    expect(sourceText('mcp:home-assistant', own)).toBe('from ~/.claude.json on this computer');
    expect(sourceText('mcp:jira', own)).toBe('from ~/.codex/config.toml on this computer');
    expect(sourceText('file:~/.claude/settings.json', own)).toBe('from ~/.claude/settings.json on this computer');
  });
});
