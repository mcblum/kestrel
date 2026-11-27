// The leak test (docs/designs/onboarding.md, risk 1): a fake home folder seeded with every kind of
// secret Kestrel knows of, read by the real readers and split by `setupRecordOf`. It fails if any
// secret value reaches the record, or if a credential store is so much as opened.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blankText, type SetupRecord } from '../shared/setup-record.ts';
import { readSetupRecord, type InventoryDeps } from './index.ts';
import { nodeFs, type FsRead, type Run } from './io.ts';
import { knownMcpServers } from './mcp.ts';
import { cleanWhoDoesWhat, NOBODY } from '../shared/who-does-what.ts';

/** Every value that must never reach a record. */
// Made-up values in the shapes the real ones have. Each is built from two pieces so the
// public-tree check, which looks for those shapes in the source, does not take this file for a leak.
const SECRETS = [
  'SECRETARG-TOKEN-0001',
  'secret-env-value-0002',
  'secretUrlPassword0003',
  'SECRETQUERY0004',
  'SECRETFRAGMENT0005',
  'SecretHeaderValue0006abcdefgh',
  'SECRETFLAGEQ0007',
  'ghp' + '_Secret0000000000000000000000000008',
  'SECRETASSIGN0009',
  'secret-local-0010',
  'secret-codex-0011',
  'secret-opencode-0012',
  'sk-' + 'ant-secretSettings0000000000000013',
  'glpat' + '-SecretGitlab00000000014',
  'SECRETSSHKEY0015',
  'SECRETDOTENV0016',
  'SECRET_GH_TOKEN_0017',
  'SECRET_GLAB_TOKEN_0018',
  'SECRETREMOTE0019',
  'SECRETCREDENTIALS0020',
  'SECRETCODEXAUTH0021',
  'SECRETOPENCODEAUTH0022',
  'SECRETDESKTOP0023',
  'aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI3', // random-looking, under no telling name
  'SECRETPATHSEG0025xxAAbbCC11ddEEff2233',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SecretJwtSignature0026',
  'SECRETPROJECTMCP0027',
  'sk-' + 'proj-SecretInstruction00000000000028',
  'glpat' + '-SecretPresetModel0000029',
];

/** Files no reader may open. */
const CREDENTIAL_FILES = ['.claude/.credentials.json', '.codex/auth.json', '.local/share/opencode/auth.json', '.ssh/id_ed25519', 'Code/wren/.env', '.config/gh/hosts.yml', '.config/glab-cli/config.yml'];

let home: string;
const wren = () => join(home, 'Code', 'wren');

function put(path: string, text: string): void {
  const full = join(home, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'kestrel-leak-'));
  put(
    '.claude.json',
    JSON.stringify({
      mcpServers: {
        'home-assistant': { command: 'uvx', args: ['mcp-ha', '--token', SECRETS[0]], env: { HOMEASSISTANT_TOKEN: SECRETS[1], HOMEASSISTANT_URL: 'http://ha.local:8123' } },
        n8n: { type: 'http', url: `https://matt:${SECRETS[2]}@n8n.example.com/mcp/${SECRETS[24]}?token=${SECRETS[3]}#${SECRETS[4]}`, headers: { Authorization: `Bearer ${SECRETS[5]}` } },
        keyed: { command: 'node', args: ['server.js', `--api-key=${SECRETS[6]}`, SECRETS[7], `API_TOKEN=${SECRETS[8]}`, SECRETS[23], SECRETS[25], '--header', `X-Custom: ${SECRETS[5]}`] },
      },
      projects: { [join(home, 'Code', 'wren')]: { mcpServers: { local: { command: 'npx', args: ['-y', 'local-mcp'], env: { LOCAL_KEY: SECRETS[9] } } } } },
    }),
  );
  put('Code/wren/.mcp.json', JSON.stringify({ mcpServers: { shared: { type: 'sse', url: 'https://mcp.example.com/sse', headers: { 'X-Api-Key': SECRETS[26] } } } }));
  put('.codex/config.toml', `model = "gpt-5"\n[mcp_servers.codexy]\ncommand = "uvx"\nargs = ["codexy"]\nenv = { X_TOKEN = "${SECRETS[10]}" }\n`);
  put('.config/opencode/opencode.json', JSON.stringify({ mcp: { oc: { type: 'local', command: ['oc-server'], environment: { OC_KEY: SECRETS[11] } } } }));
  put('Library/Application Support/Claude/claude_desktop_config.json', JSON.stringify({ mcpServers: { mail: { command: 'npx', args: ['mail-mcp'], env: { MAIL_PASSWORD: SECRETS[22], MAIL_HOST: 'imap.example.com' } } } }));
  put('.claude/settings.json', JSON.stringify({ env: { ANTHROPIC_API_KEY: SECRETS[12], DISABLE_TELEMETRY: '1' }, enabledPlugins: { 'caveman@caveman': true }, hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'rtk hook claude' }] }] } }));
  put('.claude/CLAUDE.md', '# My instructions\nBe brief.\n');
  put('.claude/rules/style.md', 'Prefer small files.\n');
  put('.claude/skills/clean/SKILL.md', '---\nname: clean\n---\nDo the clean thing. Commit c0ffee1234567890abcdef1234567890abcdef12.\n');
  put('.claude/skills/dirty/SKILL.md', '---\nname: dirty\n---\n');
  put('.claude/skills/dirty/README.md', `Setup\n\nexport GITLAB=${SECRETS[13]}\n`);
  put('.ssh/config', 'Host forge\n  HostName forge.example.com\n  User git\n  Port 2222\n  IdentityFile ~/.ssh/id_ed25519\n  UseKeychain yes\n');
  put('.ssh/id_ed25519', `-----BEGIN OPENSSH ${'PRIVATE'} KEY-----\n${SECRETS[14]}\n-----END OPENSSH ${'PRIVATE'} KEY-----\n`);
  put('.ssh/id_ed25519.pub', 'ssh-ed25519 AAAAC3Nz public@host\n');
  put('Code/wren/.env', `TOKEN=${SECRETS[15]}\n`);
  put('Code/wren/package.json', JSON.stringify({ name: 'wren', packageManager: 'pnpm@9.1.0+sha512.abc' }));
  put('Code/wren/uv.lock', '');
  put('.claude/.credentials.json', JSON.stringify({ token: SECRETS[19] }));
  put('.codex/auth.json', JSON.stringify({ OPENAI_API_KEY: SECRETS[20] }));
  put('.local/share/opencode/auth.json', JSON.stringify({ anthropic: { key: SECRETS[21] } }));
  put('.config/gh/hosts.yml', `github.com:\n  oauth_token: ${SECRETS[16]}\n`);
  put('.config/glab-cli/config.yml', `hosts:\n  gitlab.com:\n    token: ${SECRETS[17]}\n`);
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

/** The real file system, noting every path a reader opens. */
function watchedFs(read: string[]): FsRead {
  return {
    text: (path) => {
      read.push(path);
      return nodeFs.text(path);
    },
    list: (dir) => nodeFs.list(dir),
    exists: (path) => nodeFs.exists(path),
  };
}

/** gh, glab and git as they answer, with their tokens in what they print. */
const run: Run = async (file, args) => {
  if (file.endsWith('gh')) return { stdout: JSON.stringify({ hosts: { 'github.com': [{ host: 'github.com', login: 'octo', state: 'success', active: true, gitProtocol: 'ssh', token: SECRETS[16], tokenSource: 'keyring' }] } }), stderr: '', code: 0 };
  if (file.endsWith('glab')) return { stdout: '', stderr: `gitlab.example.com\n  ✓ Logged in to gitlab.example.com as octo (keyring)\n  ✓ Git operations for gitlab.example.com configured to use ssh protocol.\n  ✓ Token: ${SECRETS[17]}\n`, code: 0 };
  if (file === 'git' && args.includes('get-url')) return { stdout: `https://oauth2:${SECRETS[18]}@gitlab.example.com/me/wren.git\n`, stderr: '', code: 0 };
  if (file === 'git') {
    const key = args.at(-1);
    const values: Record<string, string> = { 'user.name': 'Octo Cat', 'user.email': 'octo@example.com', 'commit.gpgsign': 'true', 'gpg.format': 'openpgp', 'user.signingkey': 'ABCDEF0123456789' };
    return key && values[key] ? { stdout: `${values[key]}\n`, stderr: '', code: 0 } : { stdout: '', stderr: '', code: 1 };
  }
  return null;
};

async function readRecord(read: string[] = []): Promise<SetupRecord> {
  const deps: InventoryDeps = {
    machine: { id: 'dev-1', name: 'MacBook Pro' },
    platform: 'mac',
    home,
    now: 1,
    path: '',
    agents: async () => ({ available: ['claude'], notes: { codex: 'Codex is not signed in.' }, signIn: ['codex'] }),
    projects: async () => [{ name: 'Wren', folders: [{ name: 'wren', path: wren() }] }],
    mcpServers: (paths) => knownMcpServers(paths, home),
    // Model presets and Who does what, with a key pasted into the note and one in a preset's model.
    whoDoesWhat: async () =>
      cleanWhoDoesWhat(
        {
          ...NOBODY,
          presets: [
            { id: 'p1', name: 'Everyday', agent: 'claude', model: 'opus', effort: 'high', fast: false },
            { id: 'p2', name: 'Leaky', agent: 'codex', model: SECRETS[28], effort: '', fast: false },
          ],
          roles: { design: 'p1', build: 'p2', review: null },
          instruction: `Reviews use the key ${SECRETS[27]} please.`,
        },
        () => 'x',
      ),
    fs: watchedFs(read),
    // gh and glab are "installed" in a folder of their own.
    run: (file, args, cwd) => run(file, args, cwd),
  };
  mkdirSync(join(home, 'bin'), { recursive: true });
  writeFileSync(join(home, 'bin', 'gh'), '');
  writeFileSync(join(home, 'bin', 'glab'), '');
  return readSetupRecord({ ...deps, path: join(home, 'bin') });
}

describe('the set-up record', () => {
  it('holds no secret value from a home folder full of them', async () => {
    const text = JSON.stringify(await readRecord());
    for (const secret of SECRETS) expect(text, `leaked ${secret}`).not.toContain(secret);
    // Nor any part of the random-looking one, nor the PEM block.
    expect(text).not.toContain('PRIVATE KEY');
  });

  it('never opens a credential store', async () => {
    const read: string[] = [];
    await readRecord(read);
    for (const file of CREDENTIAL_FILES) expect(read, file).not.toContain(join(home, file));
    expect(read.some((p) => p.endsWith('.env'))).toBe(false);
  });

  it('keeps the names, as named blanks', async () => {
    const record = await readRecord();
    const server = (name: string) => record.mcp.find((s) => s.name === name)!;
    expect(server('home-assistant').env).toEqual(['HOMEASSISTANT_TOKEN', 'HOMEASSISTANT_URL']);
    expect(server('home-assistant').args).toEqual(['mcp-ha', '--token', null]);
    expect(server('n8n').url).toBe('https://n8n.example.com/mcp/…?token=');
    expect(server('n8n').blanks.map(blankText)).toEqual(['Authorization', 'the user name in its address', 'the password in its address', 'part 2 of its address', 'the token query value', 'the part after # in its address'].map((t, i) => (i === 0 ? 'the Authorization header' : t)));
    expect(server('keyed').args).toEqual(['server.js', '--api-key=…', null, 'API_TOKEN=…', null, null, '--header', null]);
    expect(server('codexy').env).toEqual(['X_TOKEN']);
    expect(server('oc').env).toEqual(['OC_KEY']);
    expect(server('mail').env).toEqual(['MAIL_PASSWORD', 'MAIL_HOST']);
    expect(server('local').scope).toBe('local');
    expect(server('shared').headers).toEqual(['X-Api-Key']);
  });

  it('carries the presets and roles, but no preset or note with a key in it', async () => {
    const record = await readRecord();
    expect(record.models?.who.presets.map((p) => p.name)).toEqual(['Everyday']);
    expect(record.models?.who.roles).toEqual({ design: 'p1', build: null, review: null });
    expect(record.models?.who.instruction).toBe('');
    expect(record.models?.instructionLeftOut).toBe(true);
  });

  it('does not carry a file with a key in it, and says where', async () => {
    const record = await readRecord();
    const dirty = record.files.find((f) => f.path === '~/.claude/skills/dirty')!;
    expect(dirty.keyAt).toEqual({ path: '~/.claude/skills/dirty/README.md', line: 3 });
    expect(record.files.find((f) => f.path === '~/.claude/skills/clean')!.keyAt).toBeNull();
    const settings = record.files.find((f) => f.path === '~/.claude/settings.json')!;
    expect(settings.env).toEqual(['ANTHROPIC_API_KEY', 'DISABLE_TELEMETRY']);
    expect(settings.plugins).toEqual(['caveman@caveman']);
  });

  it('reads hosts, git, SSH, tools and projects by name', async () => {
    const record = await readRecord();
    expect(record.hosts).toEqual([
      { tool: 'gh', host: 'github.com', user: 'octo', protocol: 'ssh', signedIn: true },
      { tool: 'glab', host: 'gitlab.example.com', user: 'octo', protocol: 'ssh', signedIn: true },
    ]);
    expect(record.git).toEqual({ name: 'Octo Cat', email: 'octo@example.com', signs: true, format: 'openpgp', signingKey: 'ABCDEF0123456789' });
    expect(record.ssh.hosts).toEqual([{ host: 'forge', hostName: 'forge.example.com', user: 'git', port: '2222', identityFiles: ['id_ed25519'], options: ['UseKeychain'] }]);
    expect(record.ssh.keyFiles).toEqual(['id_ed25519', 'id_ed25519.pub']);
    expect(record.projects).toEqual([{ name: 'Wren', folders: [{ name: 'wren', path: '~/Code/wren', origin: 'https://gitlab.example.com/me/wren.git' }] }]);
    expect(record.tools.map((t) => t.name)).toEqual(['node', 'oc-server', 'pnpm', 'rtk', 'uv']);
    expect(record.tools.find((t) => t.name === 'pnpm')!.why).toEqual(["pnpm@9.1.0 in Wren's package.json"]);
    expect(record.agents).toEqual([
      { agent: 'claude', state: 'ready' },
      { agent: 'codex', state: 'signed-out' },
      { agent: 'opencode', state: 'missing' },
    ]);
  });
});
