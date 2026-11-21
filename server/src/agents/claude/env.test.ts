import { NO_TOOLS } from '../test-support.ts';
import { describe, expect, it } from 'vitest';
import { claudeEnv } from './env.ts';
import { baseOptions } from './options.ts';

describe('the environment the SDK runs with', () => {
  it('keeps the environment (ssh agent, proxies, git settings) and drops what redirects sign-in', () => {
    const env = { HOME: '/h', PATH: '/bin', SSH_AUTH_SOCK: '/s', HTTPS_PROXY: 'p', GIT_AUTHOR_NAME: 'n', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'x', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'u' };
    const out = claudeEnv(env);
    expect(out).toEqual({ HOME: '/h', PATH: '/bin', SSH_AUTH_SOCK: '/s', HTTPS_PROXY: 'p', GIT_AUTHOR_NAME: 'n' });
  });
  it('is the same whether or not the server runs inside a Claude session', () => {
    const plain = { HOME: '/h', EDITOR: 'vi' };
    expect(claudeEnv({ ...plain, CLAUDECODE: '1' })).toEqual(claudeEnv(plain));
  });
});

describe('SDK options', () => {
  const opts = { directory: '/w', permission: 'ask' as const, instruction: 'x', tools: NO_TOOLS };
  it('switches on the task-list tools and the session-state messages, which the SDK leaves off unless asked', () => {
    expect(baseOptions(opts, { CLAUDE_CODE_ENABLE_TODO_TOOLS: '0', HOME: '/h' }).env).toEqual({ HOME: '/h', CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' });
    expect(baseOptions({ ...opts, permission: 'readonly' as const }, {}).env).toMatchObject({ CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' });
  });
  it('loads no settings', () => {
    const o = baseOptions(opts, {});
    expect(o.settingSources).toEqual([]);
    expect(o.permissionMode).toBe('default');
  });
  it('read-only blocks every write tool and shares only the listed folders', () => {
    const o = baseOptions({ ...opts, permission: 'readonly' as const, readableDirectories: ['/p'] }, {});
    expect(o.permissionMode).toBe('dontAsk');
    expect(o.disallowedTools).toEqual(expect.arrayContaining(['Write', 'Edit', 'Bash']));
    expect(o.additionalDirectories).toEqual(['/p']);
    expect(o.allowedTools).toEqual(expect.arrayContaining(['TaskCreate', 'TaskUpdate']));
  });
  it('skips prompts only at the bypass level, and says so to the SDK', () => {
    const o = baseOptions({ ...opts, permission: 'bypass' as const }, {});
    expect(o.permissionMode).toBe('bypassPermissions');
    expect(o.allowDangerouslySkipPermissions).toBe(true);
    expect(baseOptions({ ...opts, permission: 'plan' as const }, {})).toMatchObject({ permissionMode: 'plan' });
    expect(baseOptions({ ...opts, permission: 'ask' as const }, {}).allowDangerouslySkipPermissions).toBeUndefined();
  });
  it('loads the user\'s settings only when the project has them switched on, and the project\'s own only inside a project', () => {
    expect(baseOptions(opts, {}).settingSources).toEqual([]);
    expect(baseOptions({ ...opts, setup: { loadSettings: false, inProject: true, mcpServers: {} } }, {}).settingSources).toEqual([]);
    expect(baseOptions({ ...opts, setup: { loadSettings: true, inProject: true, mcpServers: {} } }, {}).settingSources).toEqual(['user', 'project', 'local']);
    expect(baseOptions({ ...opts, setup: { loadSettings: true, inProject: false, mcpServers: {} } }, {}).settingSources).toEqual(['user']);
  });
  it('never takes MCP servers from settings files, whatever else is loaded', () => {
    expect(baseOptions(opts, {}).strictMcpConfig).toBe(true);
    expect(baseOptions({ ...opts, setup: { loadSettings: true, inProject: true, mcpServers: {} } }, {}).strictMcpConfig).toBe(true);
    expect(baseOptions({ ...opts, permission: 'readonly' as const, setup: { loadSettings: true, inProject: true, mcpServers: {} } }, {}).strictMcpConfig).toBe(true);
  });
  it('an editing session with no project can read the listed folders and keeps its prompts', () => {
    const o = baseOptions({ ...opts, permission: 'ask' as const, readableDirectories: ['/p'] }, {});
    expect(o.permissionMode).toBe('default');
    expect(o.additionalDirectories).toEqual(['/p']);
    expect(baseOptions({ ...opts, permission: 'ask' as const }, {}).additionalDirectories).toBeUndefined();
  });
});

describe('the Claude binary', () => {
  const opts = { directory: '/w', permission: 'ask' as const, instruction: 'x', tools: NO_TOOLS };
  it('lets the SDK find its own binary from a checkout', () => {
    expect(baseOptions(opts, { HOME: '/h' })).not.toHaveProperty('pathToClaudeCodeExecutable');
  });
  it('uses the binary the packaged app names', () => {
    const o = baseOptions(opts, { HOME: '/h', KESTREL_CLAUDE_EXECUTABLE: '/App/Contents/Resources/bin/claude' });
    expect(o.pathToClaudeCodeExecutable).toBe('/App/Contents/Resources/bin/claude');
  });
});
