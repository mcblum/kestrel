import { describe, expect, test } from 'vitest';
import { EMPTY_GIT_SETTINGS, gitSshCommand, identityFor, identityHosts, identityIncludes, identityProblem, kestrelGitEnv, nodeGitPaths, nodeGitSettingsText, parseNodeGitSettings, withKestrelGitEnv, type NodeGitSettings } from './node-git.ts';

const PATHS = nodeGitPaths('/home/me/.kestrel');
const SET: NodeGitSettings = { ...EMPTY_GIT_SETTINGS, key: { fingerprint: 'SHA256:abc', madeAt: 1 }, name: 'Sam Rivera', email: 'sam@example.com' };

describe('where the node keeps its git', () => {
  test('one folder in Kestrel’s, never ~/.ssh', () => {
    expect(PATHS).toEqual({ folder: '/home/me/.kestrel/git', key: '/home/me/.kestrel/git/id_ed25519', publicKey: '/home/me/.kestrel/git/id_ed25519.pub', knownHosts: '/home/me/.kestrel/git/known_hosts', settings: '/home/me/.kestrel/git/git.json', identity: '/home/me/.kestrel/git/identity' });
    expect(Object.values(PATHS).some((p) => p.includes('.ssh'))).toBe(false);
  });
});

describe('the settings file', () => {
  test('written and read back the same', () => {
    const full: NodeGitSettings = { ...SET, signing: 'node-key', hosts: { 'github.com': { answer: 'works', addedBy: 'gh', at: 5, email: 'sam@users.example.com', signing: 'registered' }, 'git.example.org': { answer: 'not-added', at: 6, name: 'Sam R.' } }, tools: { gh: { installed: true, by: 'kestrel', signedIn: ['github.com'], notSignedIn: [] }, glab: { installed: false } } };
    expect(parseNodeGitSettings(nodeGitSettingsText(full))).toEqual(full);
  });

  test('anything else is left out, and a broken file is no settings', () => {
    expect(parseNodeGitSettings(null)).toEqual(EMPTY_GIT_SETTINGS);
    expect(parseNodeGitSettings('{not json')).toEqual(EMPTY_GIT_SETTINGS);
    const odd = parseNodeGitSettings(JSON.stringify({ key: { fingerprint: 'MD5:x' }, name: 'A <b>', email: 'nope', signing: 'gpg', hosts: { '-oProxyCommand=x': { answer: 'works' }, 'Example.org': { answer: 'maybe' }, 'git.example.org': { answer: 'not-added', addedBy: 'curl', email: 'not an email', signing: 'done' } } }));
    expect(odd).toEqual({ ...EMPTY_GIT_SETTINGS, hosts: { 'git.example.org': { answer: 'not-added', at: 0 } } });
  });
});

describe('identityProblem', () => {
  test('what git takes as a name and an email', () => {
    expect(identityProblem('Sam Rivera', 'name')).toBeNull();
    expect(identityProblem('sam@example.com', 'email')).toBeNull();
    expect(identityProblem('  ', 'name')).toBe('A name is needed.');
    expect(identityProblem('Sam <x>', 'name')).toBe('Without angle brackets or line breaks.');
    expect(identityProblem('sam', 'email')).toBe('An email address looks like name@example.com.');
    expect(identityProblem('a'.repeat(201), 'name')).toBe('At most 200 characters.');
  });
});

describe('the environment Kestrel’s git runs in', () => {
  test('the app gets nothing', () => {
    expect(kestrelGitEnv('app', { ...SET, signing: 'node-key' }, PATHS, true)).toEqual({});
  });

  test('a node: its key only, its own known hosts, no question; and the commit name and email, as git settings', () => {
    expect(kestrelGitEnv('node', SET, PATHS, true)).toEqual({
      GIT_SSH_COMMAND: 'ssh -F none -i /home/me/.kestrel/git/id_ed25519 -o IdentitiesOnly=yes -o IdentityAgent=none -o UserKnownHostsFile=/home/me/.kestrel/git/known_hosts -o StrictHostKeyChecking=yes -o BatchMode=yes',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'Sam Rivera',
      GIT_CONFIG_KEY_1: 'user.email',
      GIT_CONFIG_VALUE_1: 'sam@example.com',
    });
  });

  test('a path with a space is quoted for the shell git runs ssh through', () => {
    expect(gitSshCommand(nodeGitPaths("/home/o'neil x/.kestrel"))).toContain(`-i '/home/o'\\''neil x/.kestrel/git/id_ed25519'`);
  });

  test('no key file, no ssh command; no name, no identity', () => {
    expect(kestrelGitEnv('node', SET, PATHS, false)).not.toHaveProperty('GIT_SSH_COMMAND');
    expect(kestrelGitEnv('node', { ...SET, name: null }, PATHS, true)).not.toHaveProperty('GIT_CONFIG_COUNT');
  });

  test('signing: with the node’s own key, or explicitly off; never a key from elsewhere', () => {
    const signing = { ...SET, name: null, email: null };
    expect(kestrelGitEnv('node', { ...signing, signing: 'node-key' }, PATHS, true)).toMatchObject({ GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'gpg.format', GIT_CONFIG_VALUE_0: 'ssh', GIT_CONFIG_KEY_1: 'user.signingkey', GIT_CONFIG_VALUE_1: PATHS.key, GIT_CONFIG_KEY_2: 'commit.gpgsign', GIT_CONFIG_VALUE_2: 'true' });
    expect(kestrelGitEnv('node', { ...signing, signing: 'off' }, PATHS, true)).toMatchObject({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false' });
    expect(kestrelGitEnv('node', { ...signing, signing: 'node-key' }, PATHS, false)).not.toHaveProperty('GIT_CONFIG_COUNT');
  });

  test('a change replaces what was set before, and leaves the rest of the environment alone', () => {
    const before = withKestrelGitEnv({ PATH: '/bin', HOME: '/home/me' }, kestrelGitEnv('node', { ...SET, signing: 'node-key' }, PATHS, true));
    const after = withKestrelGitEnv(before, kestrelGitEnv('node', { ...SET, signing: null }, PATHS, true));
    expect(after.PATH).toBe('/bin');
    expect(after.GIT_CONFIG_VALUE_0).toBe('Sam Rivera');
    expect(after.GIT_CONFIG_COUNT).toBe('2');
    expect(Object.keys(after).filter((k) => k.startsWith('GIT_CONFIG_KEY'))).toEqual(['GIT_CONFIG_KEY_0', 'GIT_CONFIG_KEY_1']);
  });
});

describe('the commit identity is per host (Matt, 2026-11-27)', () => {
  const PER: NodeGitSettings = { ...SET, hosts: { 'github.com': { answer: 'works', at: 1, email: 'sam@users.noreply.example.com' }, 'git.example.org': { answer: 'works', at: 1 } } };

  test('a host with its own email gets it; a host with none, and a repository of unknown host, get the default', () => {
    expect(identityFor(PER, 'github.com')).toEqual({ name: 'Sam Rivera', email: 'sam@users.noreply.example.com' });
    expect(identityFor(PER, 'git.example.org')).toEqual({ name: 'Sam Rivera', email: 'sam@example.com' });
    expect(identityFor(PER, null)).toEqual({ name: 'Sam Rivera', email: 'sam@example.com' });
    expect(identityHosts(PER)).toEqual(['github.com']);
  });

  test('a session’s agent in a repository at each host: that host’s identity first, and every host’s include for the others', () => {
    const atGithub = kestrelGitEnv('node', PER, PATHS, true, 'github.com');
    const atGitlab = kestrelGitEnv('node', PER, PATHS, true, 'git.example.org');
    expect(atGithub.GIT_CONFIG_VALUE_1).toBe('sam@users.noreply.example.com');
    expect(atGitlab.GIT_CONFIG_VALUE_1).toBe('sam@example.com');
    const includes = Object.entries(atGitlab).filter(([k, v]) => k.startsWith('GIT_CONFIG_KEY') && v.startsWith('includeIf.')).map(([, v]) => v);
    expect(includes).toEqual(['includeIf.hasconfig:remote.*.url:git@github.com:**/**.path', 'includeIf.hasconfig:remote.*.url:ssh://git@github.com/**.path', 'includeIf.hasconfig:remote.*.url:https://github.com/**.path']);
    expect(identityIncludes(PER, PATHS)).toEqual([{ path: '/home/me/.kestrel/git/identity/github.com.gitconfig', text: '[user]\n\tname = "Sam Rivera"\n\temail = "sam@users.noreply.example.com"\n' }]);
  });
});
