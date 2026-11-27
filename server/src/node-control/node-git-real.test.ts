// The node's git environment with real git and ssh-keygen: each repository commits with its host's identity, and a
// commit made with signing on carries a signature that verifies against the node's key. Run in a temporary folder;
// nothing of the user's git configuration is read (the test setup points git's global file elsewhere).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { EMPTY_GIT_SETTINGS, kestrelGitEnv, nodeGitPaths, type NodeGitSettings } from '../shared/node-git.ts';
import { writeIdentityIncludes } from './node-git-env.ts';
import { sessionGitEnvFor } from '../runtime/session-git.ts';
import { nodeGitSettingsText } from '../shared/node-git.ts';

let root: string;
let paths: ReturnType<typeof nodeGitPaths>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kn-git-real-'));
  paths = nodeGitPaths(join(root, '.kestrel'));
  mkdirSync(paths.folder, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** The test setup's git environment, less the identity it sets, plus Kestrel's for the node. */
function envWith(git: Record<string, string>): NodeJS.ProcessEnv {
  const { GIT_AUTHOR_NAME: _a, GIT_AUTHOR_EMAIL: _b, GIT_COMMITTER_NAME: _c, GIT_COMMITTER_EMAIL: _d, ...rest } = process.env;
  return { ...rest, ...git };
}

const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

function repo(name: string, remote: string): string {
  const dir = join(root, name);
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remote]);
  return dir;
}

const gitVersion = (): number[] => (/(\d+)\.(\d+)/.exec(execFileSync('git', ['--version'], { encoding: 'utf8' })) ?? []).slice(1).map(Number);
const hasconfigWorks = (): boolean => {
  const [major = 0, minor = 0] = gitVersion();
  return major > 2 || (major === 2 && minor >= 36);
};

function makeKey(): void {
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'kestrel-node test', '-f', paths.key]);
}

const SETTINGS: NodeGitSettings = {
  ...EMPTY_GIT_SETTINGS,
  key: { fingerprint: 'SHA256:test', madeAt: 1 },
  name: 'Sam Rivera',
  email: 'sam@gitlab.example.test',
  hosts: { 'github.com': { answer: 'works', at: 1, email: 'sam@users.noreply.github.example' } },
};

describe('per-host commit identity, with real git', () => {
  test('a session in a repository at each host commits with that host’s address', () => {
    makeKey();
    writeIdentityIncludes(SETTINGS, paths);
    const github = repo('a', 'git@github.com:acme/a.git');
    const gitlab = repo('b', 'git@gitlab.example.test:group/sub/b.git');
    for (const [dir, host, email] of [
      [github, 'github.com', 'sam@users.noreply.github.example'],
      [gitlab, 'gitlab.example.test', 'sam@gitlab.example.test'],
    ] as const) {
      const env = envWith(kestrelGitEnv('node', SETTINGS, paths, true, host));
      git(dir, ['commit', '-q', '--allow-empty', '-m', 'x'], env);
      expect(git(dir, ['log', '-1', '--format=%an <%ae> / %cn <%ce>'], env)).toBe(`Sam Rivera <${email}> / Sam Rivera <${email}>`);
    }
  });

  test.skipIf(!hasconfigWorks())('Kestrel’s own git, with no host given, still picks each repository’s address (git 2.36 and later)', () => {
    writeIdentityIncludes(SETTINGS, paths);
    const env = envWith(kestrelGitEnv('node', SETTINGS, paths, false, null));
    const https = repo('c', 'https://github.com/acme/c.git');
    const other = repo('d', 'ssh://git@gitlab.example.test/group/d.git');
    expect(git(https, ['config', 'user.email'], env)).toBe('sam@users.noreply.github.example');
    expect(git(other, ['config', 'user.email'], env)).toBe('sam@gitlab.example.test');
    expect(readFileSync(join(paths.identity, 'github.com.gitconfig'), 'utf8')).toContain('sam@users.noreply.github.example');
  });

  test('with signing on, a commit made there carries a signature that verifies against the node’s key', () => {
    makeKey();
    const settings: NodeGitSettings = { ...SETTINGS, signing: 'node-key' };
    const dir = repo('signed', 'git@github.com:acme/signed.git');
    const env = envWith(kestrelGitEnv('node', settings, paths, true, 'github.com'));
    git(dir, ['commit', '-q', '--allow-empty', '-m', 'signed'], env);
    // An allowed-signers file made for the test, as a host's verification would: the commit email and the public half.
    const signers = join(root, 'allowed_signers');
    writeFileSync(signers, `sam@users.noreply.github.example ${readFileSync(paths.publicKey, 'utf8').trim()}\n`);
    const verified = execFileSync('git', ['-c', `gpg.ssh.allowedSignersFile=${signers}`, 'verify-commit', 'HEAD'], { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(verified).toBe('');
    expect(git(dir, ['-c', `gpg.ssh.allowedSignersFile=${signers}`, 'log', '-1', '--format=%G?'], env)).toBe('G');
  });
});

describe('the environment a session’s agent is given', () => {
  test('on a node, the identity of the host of the repository the session works in; in the app, nothing', async () => {
    writeFileSync(paths.settings, nodeGitSettingsText(SETTINGS));
    const dataDir = join(root, '.kestrel');
    const atGithub = await sessionGitEnvFor('node', dataDir, repo('s1', 'https://github.com/acme/s1.git'));
    const atGitlab = await sessionGitEnvFor('node', dataDir, repo('s2', 'git@gitlab.example.test:acme/s2.git'));
    const plain = await sessionGitEnvFor('node', dataDir, join(root));
    expect([atGithub.GIT_CONFIG_KEY_1, atGithub.GIT_CONFIG_VALUE_1]).toEqual(['user.email', 'sam@users.noreply.github.example']);
    expect(atGitlab.GIT_CONFIG_VALUE_1).toBe('sam@gitlab.example.test');
    expect(plain.GIT_CONFIG_VALUE_1).toBe('sam@gitlab.example.test');
    expect(await sessionGitEnvFor('app', dataDir, repo('s3', 'https://github.com/acme/s3.git'))).toEqual({});
  });
});
