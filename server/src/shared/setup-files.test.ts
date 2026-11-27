import { describe, expect, test } from 'vitest';
import { asSetupFileRecord, fileRecordsOf, fillBlanks, settingsFileOf } from './setup-files.ts';
import type { MachineInventory } from './setup-record.ts';

const HOME = '/home/someone';
const FAKE_KEY = 'sk-ant-' + 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1yZ';

const inventory = (files: MachineInventory['files']): MachineInventory => ({ machine: { id: 'm1', name: 'Laptop', platform: 'mac' }, home: HOME, files } as unknown as MachineInventory);

describe('settingsFileOf', () => {
  test('a JSON settings file keeps its shape; env values and key-named values become blanks', () => {
    const split = settingsFileOf('/x/settings.json', JSON.stringify({ model: 'opus', env: { ANTHROPIC_API_KEY: 'abc', DEBUG: '1' }, hooks: { apiToken: 'zzz' }, theme: 'dark' }));
    expect(JSON.parse(split!.text)).toEqual({ model: 'opus', env: { ANTHROPIC_API_KEY: '', DEBUG: '' }, hooks: { apiToken: '' }, theme: 'dark' });
    expect(split!.blanks.map((b) => b.name)).toEqual(['ANTHROPIC_API_KEY', 'DEBUG', 'hooks.apiToken']);
  });

  test('a value that looks like a key is blanked whatever its name', () => {
    const split = settingsFileOf('/x/opencode.json', JSON.stringify({ provider: { anthropic: { options: { thing: FAKE_KEY } } } }));
    expect(split!.text).not.toContain(FAKE_KEY);
    expect(split!.blanks).toEqual([{ name: 'provider.anthropic.options.thing', at: ['provider', 'anthropic', 'options', 'thing'] }]);
  });

  test("Codex's config.toml drops its MCP servers and blanks env and header values", () => {
    const toml = 'model = "gpt-5"\n[mcp_servers.notes]\ncommand = "uvx"\n[shell_environment_policy.set]\nPATH = "/usr/bin"\n[model_providers.x]\nhttp_headers = { "X-Key" = "secret-value" }\n';
    const split = settingsFileOf('/x/config.toml', toml)!;
    expect(split.text).toContain('model = "gpt-5"');
    expect(split.text).not.toContain('mcp_servers');
    expect(split.text).not.toContain('secret-value');
    expect(split.blanks.map((b) => b.name)).toEqual(['X-Key']);
  });

  test('a file that does not parse is not carried', () => {
    expect(settingsFileOf('/x/opencode.jsonc', '{ // a comment\n}')).toBeNull();
  });
});

describe('fileRecordsOf', () => {
  test('one record per line: skills together, a single file alone, a file with a key left out whole', () => {
    const records = fileRecordsOf(
      inventory([
        { agent: 'claude', kind: 'instructions', path: `${HOME}/.claude/CLAUDE.md`, texts: [{ path: `${HOME}/.claude/CLAUDE.md`, text: '# rules\n' }] },
        { agent: 'claude', kind: 'skill', path: `${HOME}/.claude/skills/a`, texts: [{ path: `${HOME}/.claude/skills/a/SKILL.md`, text: 'a' }] },
        { agent: 'claude', kind: 'skill', path: `${HOME}/.claude/skills/b`, texts: [{ path: `${HOME}/.claude/skills/b/SKILL.md`, text: 'b' }, { path: `${HOME}/.claude/skills/b/logo.png`, text: '' }] },
        { agent: 'claude', kind: 'skill', path: `${HOME}/.claude/skills/dirty`, texts: [{ path: `${HOME}/.claude/skills/dirty/README.md`, text: `key ${FAKE_KEY}` }] },
      ]),
    );
    expect(records.map((r) => r.line)).toEqual(['file:~/.claude/CLAUDE.md', 'files:claude:skill']);
    const skills = records[1]!;
    expect(skills.files.map((f) => f.path)).toEqual(['~/.claude/skills/a/SKILL.md', '~/.claude/skills/b/SKILL.md']);
    expect(skills.skipped).toEqual([{ path: '~/.claude/skills/b/logo.png', why: expect.stringContaining('binary') }]);
    expect(JSON.stringify(records)).not.toContain(FAKE_KEY);
  });

  test('a settings file goes in split, with its blanks', () => {
    const [record] = fileRecordsOf(inventory([{ agent: 'claude', kind: 'settings', path: `${HOME}/.claude/settings.json`, texts: [{ path: `${HOME}/.claude/settings.json`, text: JSON.stringify({ env: { GITHUB_TOKEN: 'ghp_' + 'a'.repeat(36) } }) }] }]));
    expect(record!.files[0]!.text).not.toContain('ghp_');
    expect(record!.blanks).toEqual([{ path: '~/.claude/settings.json', name: 'GITHUB_TOKEN', at: ['env', 'GITHUB_TOKEN'] }]);
  });

  test('a record read back is checked for shape', () => {
    expect(asSetupFileRecord({ kind: 'setup-files' })).toBeNull();
    const [record] = fileRecordsOf(inventory([{ agent: 'codex', kind: 'instructions', path: `${HOME}/.codex/AGENTS.md`, texts: [{ path: `${HOME}/.codex/AGENTS.md`, text: 'x' }] }]));
    expect(asSetupFileRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });
});

describe('fillBlanks', () => {
  test('puts the values typed here at their blanks', () => {
    const text = JSON.stringify({ env: { A: '' } });
    expect(JSON.parse(fillBlanks('/x/settings.json', text, { [JSON.stringify(['env', 'A'])]: 'typed' }))).toEqual({ env: { A: 'typed' } });
  });
});
