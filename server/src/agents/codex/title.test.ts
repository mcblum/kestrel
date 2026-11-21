import { EventEmitter } from 'node:events';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { PR_TEXT_INSTRUCTION, PR_TEXT_TIMEOUT_MS } from '../pr-text-request.ts';
import { TITLE_INSTRUCTION, TITLE_TIMEOUT_MS } from '../title-request.ts';
import { findCodex, type Lookup } from './binary.ts';
import { mcpServerNames } from './quiet.ts';
import { codexPullRequestText, codexTitle, type CodexTitleDeps, type TitleChild } from './title.ts';

const BIN = '/Users/me/.nvm/versions/node/v24.15.0/bin/codex';

/** A fake child process: records stdin and kills, and does what `behave` says once spawned. */
function fakeSpawn(behave: (child: EventEmitter & TitleChild, args: readonly string[]) => void) {
  const runs: { command: string; args: readonly string[]; cwd: string; env: Record<string, string | undefined>; stdin: string; killed: string[] }[] = [];
  const spawn: CodexTitleDeps['spawn'] = (command, args, { cwd, env }) => {
    const run = { command, args, cwd, env, stdin: '', killed: [] as string[] };
    runs.push(run);
    const child = Object.assign(new EventEmitter(), {
      stdin: { end: (text: string) => void (run.stdin = text), on: () => undefined },
      stderr: new EventEmitter(),
      kill: (signal?: NodeJS.Signals) => (run.killed.push(signal ?? 'SIGTERM'), true),
    }) as unknown as EventEmitter & TitleChild;
    queueMicrotask(() => behave(child, args));
    return child;
  };
  return { spawn, runs };
}

const outFileOf = (args: readonly string[]) => args[args.indexOf('--output-last-message') + 1]!;
const never = () => new Promise<void>(() => undefined);
const CONFIG = 'model = "gpt-x"\n[mcp_servers.node_repl]\ncommand = "x"\n[mcp_servers.node_repl.env]\nA = "1"\n[mcp_servers.home-assistant]\ncommand = "y"\n';
const deps = (spawn: CodexTitleDeps['spawn'], over: Partial<CodexTitleDeps> = {}): CodexTitleDeps => ({ spawn, find: () => BIN, wait: never, env: { PATH: '/usr/bin:/bin' }, readConfig: () => CONFIG, ...over });

describe('codexTitle', () => {
  it('runs codex exec read-only, outside any repository, not saved, and returns the final message', async () => {
    const fake = fakeSpawn((child, args) => {
      writeFileSync(outFileOf(args), 'Debug upload page hang\n');
      child.emit('close', 0);
    });
    expect(await codexTitle('Fix the upload\nIt hangs', deps(fake.spawn))).toBe('Debug upload page hang');
    const run = fake.runs[0]!;
    expect(run.command).toBe(BIN);
    expect(run.args).toEqual(['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '-c', 'model_reasoning_effort="low"', '--disable', 'plugins', '-c', 'notify=[]', '-c', 'mcp_servers.node_repl.enabled=false', '-c', 'mcp_servers.home-assistant.enabled=false', '--cd', run.cwd, '--output-last-message', outFileOf(run.args), '-']);
    expect(run.args).not.toContain('--model');
    expect(run.cwd.startsWith(tmpdir())).toBe(true);
    expect(existsSync(run.cwd)).toBe(false); // its temp folder is removed afterwards
    expect(run.env.PATH).toBe('/Users/me/.nvm/versions/node/v24.15.0/bin:/usr/bin:/bin'); // its node is found
    expect(run.stdin.startsWith(TITLE_INSTRUCTION)).toBe(true);
    expect(run.stdin).toContain('<message>\nFix the upload\nIt hangs\n</message>');
  });

  it('kills the child and returns null when the time limit passes first', async () => {
    const fake = fakeSpawn(() => undefined); // never exits
    const waited: number[] = [];
    expect(await codexTitle('Fix it', deps(fake.spawn, { wait: async (ms) => void waited.push(ms) }))).toBeNull();
    expect(waited).toEqual([TITLE_TIMEOUT_MS]);
    expect(fake.runs[0]!.killed).toEqual(['SIGTERM']);
  });

  it('returns null without running anything when codex is not installed', async () => {
    const fake = fakeSpawn(() => undefined);
    expect(await codexTitle('Fix it', deps(fake.spawn, { find: () => null }))).toBeNull();
    expect(fake.runs).toEqual([]);
  });

  it('throws with the end of stderr when codex fails, and when it cannot be run', async () => {
    const failing = fakeSpawn((child) => {
      (child.stderr as unknown as EventEmitter).emit('data', 'Error: Not logged in. Run codex login.');
      child.emit('close', 1);
    });
    await expect(codexTitle('Fix it', deps(failing.spawn))).rejects.toThrow(/codex exited with 1: Error: Not logged in/);
    const broken = fakeSpawn((child) => child.emit('error', new Error('spawn EACCES')));
    await expect(codexTitle('Fix it', deps(broken.spawn))).rejects.toThrow(/EACCES/);
  });
});

describe('codexPullRequestText', () => {
  const answering = () =>
    fakeSpawn((child, args) => {
      writeFileSync(outFileOf(args), 'Cache search\n\n- One\n');
      child.emit('close', 0);
    });

  it('runs with the session\'s model as one --model= argument, the pull request instruction first', async () => {
    const fake = answering();
    expect(await codexPullRequestText('<commits>\nx\n</commits>', 'gpt-5.2-codex', deps(fake.spawn))).toBe('Cache search\n\n- One');
    const run = fake.runs[0]!;
    expect(run.args).toContain('--model=gpt-5.2-codex');
    expect(run.args.indexOf('--model=gpt-5.2-codex')).toBeLessThan(run.args.indexOf('-'));
    expect(run.stdin.startsWith(PR_TEXT_INSTRUCTION)).toBe(true);
    expect(run.stdin).toContain('<commits>\nx\n</commits>');
  });

  it('leaves the user\'s configured model when the session has none', async () => {
    for (const model of [undefined, '']) {
      const fake = answering();
      await codexPullRequestText('x', model, deps(fake.spawn));
      expect(fake.runs[0]!.args.some((a) => a.startsWith('--model'))).toBe(false);
    }
  });

  it('gives up at the pull request time limit, not the title one', async () => {
    const fake = fakeSpawn(() => undefined);
    const waited: number[] = [];
    expect(await codexPullRequestText('x', 'gpt-5.2-codex', deps(fake.spawn, { wait: async (ms) => void waited.push(ms) }))).toBeNull();
    expect(waited).toEqual([PR_TEXT_TIMEOUT_MS]);
    expect(fake.runs[0]!.killed).toEqual(['SIGTERM']);
  });
});

describe('mcpServerNames', () => {
  it('lists the servers config.toml defines, not their sub-tables, comments or names codex cannot take in a -c path', () => {
    const toml = '[mcp_servers.a]\n[mcp_servers.a.env]\n# [mcp_servers.commented]\n[ mcp_servers.b ] # note\n[mcp_servers."dotted.name"]\n[projects."/x"]\n[mcp_servers.a]\n';
    expect(mcpServerNames(toml)).toEqual(['a', 'b']);
    expect(mcpServerNames('')).toEqual([]);
  });

  it('overrides no server when there is no config', async () => {
    const fake = fakeSpawn((child) => child.emit('close', 0));
    await codexTitle('Fix it', deps(fake.spawn, { readConfig: () => null }));
    expect(fake.runs[0]!.args.filter((a) => a.startsWith('mcp_servers.'))).toEqual([]);
    expect(fake.runs[0]!.args).toContain('plugins');
  });
});

describe('findCodex', () => {
  const lookup = (present: string[], nvmVersions: string[] = []): Lookup => ({
    exists: (p) => present.includes(p),
    list: (dir) => (dir === '/Users/me/.nvm/versions/node' ? nvmVersions : []),
    home: '/Users/me',
  });

  it('takes codex from PATH first', () => {
    expect(findCodex({ PATH: '/a:/b' }, lookup(['/b/codex', '/opt/homebrew/bin/codex']))).toBe('/b/codex');
  });

  it('looks in the usual install folders when an app launched from the Dock has a minimal PATH', () => {
    expect(findCodex({ PATH: '/usr/bin:/bin' }, lookup(['/opt/homebrew/bin/codex']))).toBe('/opt/homebrew/bin/codex');
    const nvm = lookup(['/Users/me/.nvm/versions/node/v9.0.0/bin/codex', '/Users/me/.nvm/versions/node/v24.15.0/bin/codex'], ['v9.0.0', 'v24.15.0']);
    expect(findCodex({ PATH: '/usr/bin' }, nvm)).toBe('/Users/me/.nvm/versions/node/v24.15.0/bin/codex');
  });

  it('is null when codex is nowhere', () => {
    expect(findCodex({}, lookup([]))).toBeNull();
  });
});
