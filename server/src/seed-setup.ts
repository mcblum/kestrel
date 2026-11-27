// Sample set-up records for Kestrel with sample data (`KESTREL_FAKE=1`), where Kestrel Connect is off:
// Set up this computer shows a list built from a sample laptop's record and a sample of this machine,
// so the page can be seen without an account. Nothing here reads the machine.
import { setupListOf, type SetupList } from './shared/setup-list.ts';
import { SETUP_RECORD_VERSION, type SetupRecord } from './shared/setup-record.ts';
import type { Platform } from './shared/platform.ts';
import { SETUP_ANSWERS } from './shared/setup-values.ts';

const base = (id: string, name: string, platform: Platform, readAt: number): SetupRecord => ({
  v: SETUP_RECORD_VERSION,
  kind: 'setup',
  machine: { id, name, platform },
  readAt,
  agents: [],
  hosts: [],
  git: { name: null, email: null, signs: false, format: null, signingKey: null },
  ssh: { hosts: [], keyFiles: [] },
  mcp: [],
  files: [],
  tools: [],
  projects: [],
  problems: [],
});

export function sampleLaptop(now: number): SetupRecord {
  const laptop = base('sample-laptop', 'MacBook Pro', 'mac', now - 3 * 60 * 60_000);
  return {
    ...laptop,
    // A current Kestrel: it answers a request for set-up values (onboarding.md 19.8).
    machine: { ...laptop.machine, answers: [...SETUP_ANSWERS] },
    agents: [
      { agent: 'claude', state: 'ready' },
      { agent: 'codex', state: 'ready' },
      { agent: 'opencode', state: 'ready' },
    ],
    hosts: [
      { tool: 'gh', host: 'github.com', user: 'sample-dev', protocol: 'ssh', signedIn: true },
      { tool: 'glab', host: 'gitlab.example.com', user: 'sample-dev', protocol: 'ssh', signedIn: true },
    ],
    git: { name: 'Sample Developer', email: 'dev@example.com', signs: true, format: 'openpgp', signingKey: '0123456789ABCDEF' },
    ssh: { hosts: [{ host: 'forge', hostName: 'gitlab.example.com', user: 'git', port: null, identityFiles: ['id_ed25519'], options: ['UseKeychain', 'AddKeysToAgent'] }, { host: 'build-box', hostName: 'build.example.com', user: 'dev', port: '2222', identityFiles: ['id_ed25519'], options: [] }], keyFiles: ['id_ed25519', 'id_ed25519.pub'] },
    mcp: [
      { name: 'home-assistant', scope: 'user', transport: 'stdio', command: 'uvx', args: ['mcp-home-assistant'], url: null, env: ['HOMEASSISTANT_TOKEN', 'HOMEASSISTANT_URL'], headers: [], blanks: [{ kind: 'env', name: 'HOMEASSISTANT_TOKEN' }, { kind: 'env', name: 'HOMEASSISTANT_URL' }], appProgram: null },
      { name: 'automations', scope: 'user', transport: 'http', command: null, args: [], url: 'https://automations.example.com/mcp', env: [], headers: ['Authorization'], blanks: [{ kind: 'header', name: 'Authorization' }], appProgram: null },
      { name: 'family-notes', scope: 'user', transport: 'sse', command: null, args: [], url: 'https://notes.example.com/sse', env: [], headers: [], blanks: [], appProgram: null },
      { name: 'photo-library', scope: 'desktop', transport: 'stdio', command: '/Applications/Photo Library.app/Contents/MacOS/mcp', args: [], url: null, env: [], headers: [], blanks: [], appProgram: 'Photo Library.app' },
    ],
    files: [
      { agent: 'claude', kind: 'instructions', path: '~/.claude/CLAUDE.md', files: 1, keyAt: null, env: [], plugins: [] },
      { agent: 'claude', kind: 'rules', path: '~/.claude/rules', files: 14, keyAt: null, env: [], plugins: [] },
      { agent: 'claude', kind: 'settings', path: '~/.claude/settings.json', files: 1, keyAt: null, env: ['ANTHROPIC_MODEL', 'GITHUB_TOKEN'], plugins: ['caveman@caveman', 'notes@tools'] },
      { agent: 'claude', kind: 'skill', path: '~/.claude/skills/release-notes', files: 3, keyAt: null, env: [], plugins: [] },
      { agent: 'claude', kind: 'skill', path: '~/.claude/skills/deploy', files: 5, keyAt: { path: '~/.claude/skills/deploy/README.md', line: 12 }, env: [], plugins: [] },
      { agent: 'codex', kind: 'instructions', path: '~/.codex/AGENTS.md', files: 1, keyAt: null, env: [], plugins: [] },
    ],
    tools: [
      { name: 'node', why: ["Wren's package.json"], found: true },
      { name: 'pnpm', why: ["pnpm@9.15.0 in Wren's package.json"], found: true },
      { name: 'uv', why: ['the MCP server home-assistant'], found: true },
      { name: 'Xcode', why: ["Xcode in Vireo's Package.swift"], found: true },
      { name: 'rtk', why: ["a hook in Claude's settings"], found: true },
    ],
    projects: [
      { name: 'Wren', folders: [{ name: 'wren', path: '~/Code/wren', origin: 'git@gitlab.example.com:dev/wren.git' }] },
      { name: 'Vireo', folders: [{ name: 'vireo', path: '~/Code/vireo', origin: 'git@github.com:sample-dev/vireo.git' }] },
      { name: 'Notes', folders: [{ name: 'notes', path: '~/Documents/notes', origin: null }] },
    ],
  };
}

/** This machine as a fresh Mac mini would read: Claude signed in at first launch, little else. */
export function sampleHere(now: number): SetupRecord {
  return {
    ...base('sample-here', 'Mac mini', 'mac', now),
    agents: [
      { agent: 'claude', state: 'ready' },
      { agent: 'codex', state: 'signed-out' },
      { agent: 'opencode', state: 'missing' },
    ],
    hosts: [{ tool: 'gh', host: 'github.com', user: 'sample-dev', protocol: 'https', signedIn: true }],
    git: { name: 'Sample Developer', email: 'dev@example.com', signs: false, format: null, signingKey: null },
    files: [{ agent: 'claude', kind: 'instructions', path: '~/.claude/CLAUDE.md', files: 1, keyAt: null, env: [], plugins: [] }],
    problems: [{ part: 'hosts', reason: 'glab is not installed.' }],
  };
}

/**
 * A new Mac as it reads before anything is set up: Claude and Codex ready, no OpenCode, no `gh` or `glab`,
 * nothing else. What the set-up list is checked against when this computer's own record is previewed.
 */
export function newMac(now: number): SetupRecord {
  return {
    ...base('preview-new-mac', 'Mac mini', 'mac', now),
    agents: [
      { agent: 'claude', state: 'ready' },
      { agent: 'codex', state: 'ready' },
      { agent: 'opencode', state: 'missing' },
    ],
    problems: [
      { part: 'hosts', reason: 'gh is not installed.' },
      { part: 'hosts', reason: 'glab is not installed.' },
    ],
  };
}

/**
 * The list a new Mac would be shown for this computer's real record: for looking at the page with real
 * amounts of data from a checkout, with no account and no second computer (`KESTREL_SETUP_PREVIEW=1`).
 */
export function previewSetupList(source: SetupRecord, now: number): SetupList {
  return setupListOf(newMac(now), [source], { tool: () => false });
}

export function sampleSetupList(now: number): SetupList {
  return setupListOf(sampleHere(now), [sampleLaptop(now)], { tool: (name) => name === 'node' });
}
