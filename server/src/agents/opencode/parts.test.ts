// The small pure parts of the OpenCode adapter: configuration, models, the user's files, the
// binary, the child's environment, prompts, and how a turn ends.
import { describe, expect, it } from 'vitest';
import { findOpencode } from './binary.ts';
import { isolationEnv, opencodeInstruction, processConfig } from './config.ts';
import { commandCalled, FILES_ONLY_TEXT, promptParts } from './input.ts';
import { contextWindow, splitModel, toOptions } from './models.ts';
import { childEnv } from './process.ts';
import { toolsStatus } from './started.ts';
import { turnEnd } from './turn-end.ts';
import { configuredServers, stripJsonc } from './user-config.ts';

describe('processConfig', () => {
  const base = { kestrel: { url: 'http://127.0.0.1:9/mcp', token: 't' }, setup: undefined, configuredServers: ['home', 'kestrel'], instructionFile: '/tmp/k/kestrel-instruction.md' };

  it("adds Kestrel's server with the session's token and switches the user's own servers off", () => {
    const config = processConfig(base) as { mcp: Record<string, Record<string, unknown>> };
    expect(config.mcp.kestrel).toMatchObject({ type: 'remote', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer t' }, oauth: false });
    expect(config.mcp.home).toEqual({ enabled: false });
    expect(config).toMatchObject({ autoupdate: false, share: 'disabled', instructions: ['/tmp/k/kestrel-instruction.md'] });
  });

  it('keeps the servers chosen for the project, in OpenCode’s shape', () => {
    const setup = { loadSettings: true, inProject: true, mcpServers: { home: { command: 'node', args: ['s.js'], env: { A: '1' } }, web: { type: 'http', url: 'https://x/mcp' } } };
    const config = processConfig({ ...base, setup }) as { mcp: Record<string, unknown> };
    expect(config.mcp.home).toEqual({ type: 'local', command: ['node', 's.js'], enabled: true, environment: { A: '1' } });
    expect(config.mcp.web).toMatchObject({ type: 'remote', url: 'https://x/mcp', enabled: true });
  });

  it("isolates a session that does not load the user's setup", () => {
    expect(isolationEnv({ loadSettings: false, inProject: true, mcpServers: {} })).toEqual({ OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1' });
    expect(isolationEnv({ loadSettings: true, inProject: true, mcpServers: {} })).toEqual({});
  });

  it("names Kestrel's tools as OpenCode does in the standing instruction", () => {
    expect(opencodeInstruction('Call mcp__kestrel__handoff or mcp__kestrel__ask_session.')).toBe('Call kestrel_handoff or kestrel_ask_session.');
  });
});

describe('models', () => {
  const listed = {
    all: [{ id: 'p', name: 'Prov', models: { a: { id: 'a', name: 'A', variants: { low: {}, high: {} }, limit: { context: 1000 } }, old: { id: 'old', status: 'deprecated' }, chat: { id: 'chat', capabilities: { toolcall: false } } } }, { id: 'q', name: 'Q', models: { b: { id: 'b' } } }],
    connected: ['p'],
  };

  it('lists only connected providers’ usable models; Default stands for the configured one', () => {
    expect(toOptions(listed, 'p/a')).toEqual([
      { id: '', label: 'Default', description: 'The model set in your OpenCode config: A', efforts: ['low', 'high'], resolves: 'p/a' },
      { id: 'p/a', label: 'A', description: 'Prov', efforts: ['low', 'high'], resolves: 'p/a' },
    ]);
  });

  it('splits provider/model and reads context windows', () => {
    expect(splitModel('amazon-bedrock/anthropic.claude/v1')).toEqual({ providerID: 'amazon-bedrock', modelID: 'anthropic.claude/v1' });
    expect(splitModel('nope')).toBeNull();
    expect(contextWindow(listed, 'p/a')).toBe(1000);
    expect(contextWindow(listed, 'q/b')).toBe(0);
  });
});

describe("the user's OpenCode files", () => {
  it('reads JSON with comments and trailing commas, leaving strings alone', () => {
    expect(JSON.parse(stripJsonc('{ "a": "http://x", // c\n /* b */ "b": [1,], }'))).toEqual({ a: 'http://x', b: [1] });
  });

  it('collects MCP server names from the global and project files, names only', () => {
    const files: Record<string, string> = {
      '/h/.config/opencode/opencode.json': '{ "mcp": { "home": { "environment": { "TOKEN": "secret" } } } }',
      '/h/code/app/opencode.jsonc': '{ "mcp": { "db": {}, } }',
    };
    expect(configuredServers('/h/code/app', { HOME: '/h' }, (p) => files[p] ?? null)).toEqual(['home', 'db']);
  });
});

describe('findOpencode', () => {
  const lookup = (present: string[]) => ({ exists: (p: string) => present.includes(p), home: '/h' });
  it('takes the override, then PATH, then the install folders', () => {
    expect(findOpencode({ KESTREL_OPENCODE_BINARY: '/x/opencode' }, lookup(['/x/opencode']))).toBe('/x/opencode');
    expect(findOpencode({ KESTREL_OPENCODE_BINARY: '/x/opencode' }, lookup([]))).toBeNull();
    expect(findOpencode({ PATH: '/a:/b' }, lookup(['/b/opencode', '/h/.opencode/bin/opencode']))).toBe('/b/opencode');
    expect(findOpencode({ PATH: '' }, lookup(['/h/.opencode/bin/opencode']))).toBe('/h/.opencode/bin/opencode');
  });
});

describe('childEnv', () => {
  it("drops Kestrel's launch token and any inherited config; sets the password and no self-update", () => {
    const env = childEnv({ PATH: '/usr/bin', KESTREL_TOKEN: 'secret', OPENCODE_CONFIG_CONTENT: '{"x":1}' }, '/h/.opencode/bin/opencode', { a: 1 }, 'pw');
    expect(env).toEqual({ PATH: '/h/.opencode/bin:/usr/bin', OPENCODE_CONFIG_CONTENT: '{"a":1}', OPENCODE_SERVER_PASSWORD: 'pw', OPENCODE_DISABLE_AUTOUPDATE: '1' });
  });
});

describe('prompts', () => {
  it('sends pictures as file parts and notes other files', () => {
    const parts = promptParts('look', [{ name: 'a.png', mediaType: 'image/png', size: 1, kind: 'image', file: '/s/a.png' }, { name: 'b.csv', mediaType: 'text/csv', size: 1, kind: 'file', file: '/s/b.csv' }]);
    expect(parts[1]).toEqual({ type: 'file', mime: 'image/png', filename: 'a.png', url: 'file:///s/a.png' });
    expect(parts[0]).toEqual({ type: 'text', text: expect.stringContaining('/s/b.csv') });
    expect(promptParts('')).toEqual([{ type: 'text', text: FILES_ONLY_TEXT }]);
  });

  it('runs a listed command, and nothing else, as a command', () => {
    const commands = [{ name: 'review', description: '' }];
    expect(commandCalled('/review main  ', commands)).toEqual({ command: 'review', arguments: 'main' });
    expect(commandCalled('/other x', commands)).toBeNull();
    expect(commandCalled('please /review', commands)).toBeNull();
  });
});

describe('the end of a turn', () => {
  const ok = { error: null, text: 'done', costUsd: 0 };
  it('complete, stopped, failed, or failed for sign-in', () => {
    expect(turnEnd(ok, false, null, 0.5)).toEqual({ type: 'done', reason: 'complete', costUsd: 0.5 });
    expect(turnEnd(ok, true, null, 0)).toEqual({ type: 'done', reason: 'stopped' });
    expect(turnEnd({ ...ok, error: 'MessageAbortedError' }, false, null, 0)).toEqual({ type: 'done', reason: 'stopped' });
    expect(turnEnd({ ...ok, error: 'Rate limited' }, false, null, 0)).toEqual({ type: 'failed', reason: 'OpenCode: Rate limited', kind: 'other' });
    expect(turnEnd({ ...ok, error: 'ProviderAuthError' }, false, null, 0)).toMatchObject({ kind: 'auth' });
    expect(turnEnd(ok, true, 'Free usage exceeded', 0)).toEqual({ type: 'failed', reason: 'Free usage exceeded', kind: 'other' });
  });
});

describe("whether the agent has Kestrel's tools", () => {
  it("is OpenCode's status of the kestrel server; the user's servers show in the detail", () => {
    expect(toolsStatus({ kestrel: { status: 'connected' }, home: { status: 'disabled' } }, ['a'])).toEqual({ kestrelTools: 'connected', missing: [], detail: 'kestrel: connected' });
    expect(toolsStatus({ kestrel: { status: 'failed', error: 'boom' } }, ['a'])).toMatchObject({ kestrelTools: 'missing', missing: ['a'], detail: expect.stringMatching(/^OpenCode could not reach Kestrel's tools: boom\./) });
    expect(toolsStatus(null, ['a'])).toMatchObject({ kestrelTools: 'missing', missing: ['a'] });
  });
});
