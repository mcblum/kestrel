// The file records (onboarding.md 18.3) over a home folder whose agent files are full of secrets: no
// secret may reach a record, in any file of any line. A companion of leak.test.ts, which stays as it is.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readSetupRecordAndFiles } from './index.ts';

const SECRETS = [
  'sk-' + 'ant-secretSettings0000000000000001',
  'secret-env-value-0002',
  'ghp' + '_Secret0000000000000000000000000003',
  'glpat' + '-SecretGitlab00000000004',
  'aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI5', // random-looking, under no telling name
  'SecretHeaderValue0006abcdefgh',
  'SECRETCODEXENV0007',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SecretJwtSignature0008',
  'SECRETPASSWORD0009',
  'SECRETMCPTOML0010',
];

const home = mkdtempSync(join(tmpdir(), 'kestrel-file-records-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const put = (path: string, text: string) => {
  mkdirSync(dirname(join(home, path)), { recursive: true });
  writeFileSync(join(home, path), text);
};

put('.claude/CLAUDE.md', '# How I work\nUse tabs.\n');
put('.claude/settings.json', JSON.stringify({ model: 'opus', env: { ANTHROPIC_API_KEY: SECRETS[0], PLAIN: SECRETS[1] }, hooks: { notify: { authToken: SECRETS[8] } }, statusLine: { command: `run ${SECRETS[4]}` } }));
put('.claude/rules/style.md', 'Short functions.\n');
put('.claude/rules/leaky.md', `token: ${SECRETS[2]}\n`);
put('.claude/skills/clean/SKILL.md', 'A clean skill.\n');
put('.claude/skills/dirty/SKILL.md', `Run with ${SECRETS[3]}\n`);
put('.codex/config.toml', `model = "gpt-5"\n[shell_environment_policy.set]\nSECRET = "${SECRETS[6]}"\n[mcp_servers.x]\ncommand = "x"\nenv = { K = "${SECRETS[9]}" }\n[model_providers.p]\nhttp_headers = { "X-Key" = "${SECRETS[5]}" }\n`);
put('.codex/AGENTS.md', `Header: Bearer ${SECRETS[7]}\n`);
put('.config/opencode/opencode.json', JSON.stringify({ provider: { anthropic: { options: { apiKey: SECRETS[0], other: SECRETS[4] } } } }));

const read = () =>
  readSetupRecordAndFiles({
    machine: { id: 'dev-1', name: 'Laptop' },
    platform: 'mac',
    home,
    now: 1,
    path: '',
    agents: async () => ({ available: ['claude'], notes: {}, signIn: [] }),
    projects: async () => [],
    mcpServers: () => [],
    run: async () => null,
  });

describe('the file records', () => {
  it('hold no secret value from agent files full of them', async () => {
    const { files } = await read();
    const text = JSON.stringify(files);
    for (const secret of SECRETS) expect(text, `leaked ${secret}`).not.toContain(secret);
  });

  it('carry the clean files, and leave out a file with a key whole', async () => {
    const { files } = await read();
    const paths = files.flatMap((r) => r.files.map((f) => f.path));
    expect(paths).toEqual(expect.arrayContaining(['~/.claude/CLAUDE.md', '~/.claude/skills/clean/SKILL.md', '~/.claude/settings.json', '~/.codex/config.toml', '~/.config/opencode/opencode.json']));
    expect(paths).not.toContain('~/.claude/skills/dirty/SKILL.md');
    expect(paths).not.toContain('~/.codex/AGENTS.md');
    // The rules folder holds a file with a key, so the folder is not carried at all (O11).
    expect(paths).not.toContain('~/.claude/rules/style.md');
  });
});
