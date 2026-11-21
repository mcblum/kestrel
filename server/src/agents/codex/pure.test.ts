// The small pure pieces of the Codex adapter: the permission table, the per-thread config, the
// input for a message, the model list and the wire parser.
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { codexInstruction, codexServerConfig, threadConfig } from './config.ts';
import { codexInput, FILES_ONLY_TEXT } from './input.ts';
import { FALLBACK_MODELS, toOptions } from './models.ts';
import { codexPolicy, sandboxPolicy } from './policy.ts';
import { childEnv, Tail } from './process.ts';
import { parseLine, RpcClosed, RpcConnection, RpcFailure } from './rpc.ts';

describe('permission levels', () => {
  it('map to an approval policy, reviewer and sandbox', () => {
    const table = Object.fromEntries((['ask', 'edits', 'auto', 'bypass', 'plan', 'readonly'] as const).map((l) => [l, (({ approvalPolicy, approvalsReviewer, sandbox }) => [approvalPolicy, approvalsReviewer, sandbox])(codexPolicy(l))]));
    expect(table).toEqual({
      ask: ['untrusted', 'user', 'workspace-write'],
      edits: ['untrusted', 'user', 'workspace-write'],
      auto: ['on-request', 'user', 'workspace-write'],
      bypass: ['untrusted', 'user', 'danger-full-access'],
      plan: ['never', 'user', 'read-only'],
      readonly: ['never', 'user', 'read-only'],
    });
    expect(codexPolicy('plan').plan).toBe(true);
    expect(codexPolicy('readonly').readOnly).toBe(true);
    expect(codexPolicy('edits').acceptEdits).toBe('folder');
    expect(codexPolicy('auto').acceptEdits).toBe('anywhere');
    expect(codexPolicy('bypass')).toMatchObject({ acceptEdits: 'anywhere', acceptAll: true });
  });

  it('give turn/start a full sandbox policy with the network on for workspace-write', () => {
    expect(sandboxPolicy('workspace-write')).toMatchObject({ type: 'workspaceWrite', networkAccess: true });
    expect(sandboxPolicy('read-only')).toEqual({ type: 'readOnly', networkAccess: false });
    expect(sandboxPolicy('danger-full-access')).toEqual({ type: 'dangerFullAccess' });
  });
});

describe('thread config', () => {
  it("adds Kestrel's tools by URL with the token read from the environment, and switches the user's other servers off", () => {
    const config = threadConfig({ kestrelUrl: 'http://127.0.0.1:1/api/sessions/s/mcp', setup: { loadSettings: true, inProject: true, mcpServers: { docs: { command: 'docs-mcp', args: ['--x'] } } }, configuredServers: ['docs', 'github', 'kestrel', 'bad name'] });
    expect(config).toMatchObject({
      'features.plugins': false,
      'features.apps': false,
      notify: [],
      'mcp_servers.docs': { command: 'docs-mcp', args: ['--x'] },
      'mcp_servers.github.enabled': false,
      'mcp_servers.kestrel': { url: 'http://127.0.0.1:1/api/sessions/s/mcp', bearer_token_env_var: 'KESTREL_MCP_TOKEN' },
    });
    expect(config).not.toHaveProperty(['mcp_servers.docs.enabled']);
    expect(config).not.toHaveProperty(['mcp_servers.bad name.enabled']);
    expect(JSON.stringify(config)).not.toMatch(/token"?:\s*"[^K]/i);
    expect(config).not.toHaveProperty(['project_doc_max_bytes']);
  });

  it("leaves the project's AGENTS.md out when the user's settings are off", () => {
    expect(threadConfig({ kestrelUrl: null, setup: { loadSettings: false, inProject: true, mcpServers: {} }, configuredServers: [] })).toMatchObject({ project_doc_max_bytes: 0 });
  });

  it('translates servers Codex can reach and drops SSE-only ones', () => {
    expect(codexServerConfig({ url: 'https://x/mcp', headers: { A: 'b' } })).toEqual({ url: 'https://x/mcp', http_headers: { A: 'b' } });
    expect(codexServerConfig({ url: 'https://x/sse', type: 'sse' })).toBeNull();
    expect(codexServerConfig({ command: 'c', env: { K: 'v' } })).toEqual({ command: 'c', args: [], env: { K: 'v' } });
    expect(codexServerConfig({})).toBeNull();
  });

  it("rewords Claude's ToolSearch step for Codex", () => {
    expect(codexInstruction('Before a tool, load it with ToolSearch first.')).toBe('Before a tool, look it up with your tool search first.');
  });
});

describe('message input', () => {
  it('sends pictures as local images and every other file in the note', () => {
    const input = codexInput('look', [
      { kind: 'image', mediaType: 'image/png', file: '/att/a.png', name: 'a.png' },
      { kind: 'file', mediaType: 'application/pdf', file: '/att/b.pdf', name: 'b.pdf' },
    ] as never);
    expect(input[0]).toMatchObject({ type: 'text' });
    expect((input[0] as { text: string }).text).toMatch(/^look\n\n[\s\S]*\/att\/b\.pdf/);
    expect(input[1]).toEqual({ type: 'localImage', path: '/att/a.png' });
    expect(input).toHaveLength(2);
  });

  it('gives a files-only message some words', () => {
    expect(codexInput('', [{ kind: 'image', mediaType: 'image/png', file: '/a.png', name: 'a.png' }] as never)[0]).toEqual({ type: 'text', text: FILES_ONLY_TEXT, text_elements: [] });
  });
});

describe('models', () => {
  it('lists the visible models after a Default named for the catalogue default', () => {
    const options = toOptions([
      { id: 'm1', displayName: 'One', description: 'first', isDefault: true },
      { id: 'm2', displayName: 'Two', hidden: true },
      { id: 'm3' },
    ]);
    expect(options).toEqual([
      { id: '', label: 'Default', description: 'The model set in your Codex config, else One', resolves: 'm1' },
      { id: 'm1', label: 'One', description: 'first', resolves: 'm1' },
      { id: 'm3', label: 'm3', resolves: 'm3' },
    ]);
  });

  it('falls back when Codex lists nothing usable', () => {
    expect(toOptions(null)).toEqual(FALLBACK_MODELS);
  });
});

describe('process helpers', () => {
  it("keeps Kestrel's launch token out of Codex's environment", () => {
    const env = childEnv({ KESTREL_TOKEN: 'secret', PATH: '/usr/bin', HOME: '/h' }, '/opt/codex/bin/codex', { EXTRA: '1' });
    expect(env.KESTREL_TOKEN).toBeUndefined();
    expect(env.EXTRA).toBe('1');
  });

  it('keeps the last of stderr without colour codes', () => {
    const tail = new Tail();
    tail.push('\u001b[31mERROR\u001b[0m one\n');
    tail.push('x'.repeat(5000));
    expect(tail.toString()).toHaveLength(4000);
    const short = new Tail();
    short.push('\u001b[31mERROR\u001b[0m one\n');
    expect(short.toString()).toBe('ERROR one');
  });
});

describe('JSON-RPC', () => {
  it('classifies each kind of line', () => {
    expect(parseLine('')).toBeNull();
    expect(parseLine('{"id":0,"result":{}}')).toEqual({ kind: 'response', id: 0, result: {} });
    expect(parseLine('{"id":1,"error":{"code":-1,"message":"no"}}')).toEqual({ kind: 'error', id: 1, error: { code: -1, message: 'no', data: undefined } });
    expect(parseLine('{"id":0,"method":"item/x","params":{"a":1}}')).toEqual({ kind: 'request', id: 0, method: 'item/x', params: { a: 1 } });
    expect(parseLine('{"method":"turn/started"}')).toEqual({ kind: 'notification', method: 'turn/started', params: {} });
    expect(parseLine('nope')).toMatchObject({ kind: 'invalid' });
    expect(parseLine('[1]')).toMatchObject({ kind: 'invalid' });
    expect(parseLine('{"id":2}')).toMatchObject({ kind: 'invalid' });
  });

  it('matches answers to requests, passes requests and notifications on, and rejects what is waiting on close', async () => {
    const fromServer = new PassThrough();
    const toServer = new PassThrough();
    const seen: string[] = [];
    const problems: string[] = [];
    const rpc = new RpcConnection(fromServer, toServer, { notification: (m) => seen.push(`n:${m}`), request: (r) => seen.push(`r:${r.method}:${String(r.id)}`), problem: (p) => problems.push(p) });
    const written: string[] = [];
    toServer.on('data', (chunk: Buffer) => written.push(...chunk.toString().trim().split('\n')));
    const ok = rpc.request('a', {});
    const bad = rpc.request('b', {});
    const never = rpc.request('c', {});
    fromServer.write('{"id":1,"result":"yes"}\n{"id":2,"error":{"code":5,"message":"no"}}\n{"method":"note"}\n{"id":0,"method":"ask"}\n{"id":99,"result":1}\n');
    await expect(ok).resolves.toBe('yes');
    await expect(bad).rejects.toBeInstanceOf(RpcFailure);
    expect(seen).toEqual(['n:note', 'r:ask:0']);
    expect(problems).toHaveLength(1);
    rpc.close('gone');
    await expect(never).rejects.toBeInstanceOf(RpcClosed);
    await expect(rpc.request('d', {})).rejects.toBeInstanceOf(RpcClosed);
    expect(written.map((l) => JSON.parse(l).method)).toEqual(['a', 'b', 'c']);
  });
});
