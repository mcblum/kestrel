import { describe, expect, test } from 'vitest';
import { fingerprintFrom, hostAnswerText, hostKeysFrom, hostsOfRepositories, sshAnswerOf, sshTestArgs, whereSigningKey, wherePasteKey } from './node-git-hosts.ts';
import { gitStatusLines, gitStatusOf, hostsWithKey, toolSignIns } from './node-git-status.ts';
import { gitToDoSummary } from './node-git-todo.ts';
import { hostKindOf, toolForHost } from './node-git-tools.ts';
import { EMPTY_GIT_SETTINGS, type NodeGitSettings } from './node-git.ts';

describe('the hosts of the account’s projects', () => {
  test('one each, in order, from repository keys; anything that is not a host is skipped', () => {
    expect(hostsOfRepositories(['github.com/acme/api', 'git.example.org/team/app', 'github.com/acme/web', 'GitLab.com/x/y', 'nohost/x', '-oProxyCommand=x/y'])).toEqual(['git.example.org', 'github.com', 'gitlab.com']);
    expect(hostsOfRepositories([])).toEqual([]);
  });

  test('GitHub is gh’s, by the pull-request code’s one rule; every other host is a GitLab, glab’s', () => {
    expect([hostKindOf('github.com'), toolForHost('github.com')]).toEqual(['github', 'gh']);
    expect([hostKindOf('ssh.github.com'), toolForHost('www.github.com')]).toEqual(['github', 'gh']);
    expect([hostKindOf('gitlab.com'), toolForHost('gitlab.com')]).toEqual(['gitlab', 'glab']);
    expect([hostKindOf('git.example.org'), toolForHost('git.example.org')]).toEqual(['gitlab', 'glab']);
  });
});

describe('where to paste the key, per host', () => {
  test('GitHub and GitLab', () => {
    expect(wherePasteKey('github.com', 'github')).toBe('At github.com: Settings → SSH and GPG keys → New SSH key, and paste the public half.');
    expect(wherePasteKey('git.example.org', 'gitlab')).toBe('At git.example.org: Preferences → SSH Keys → Add new key, and paste the public half.');
  });

  test('and where it is registered as a signing key', () => {
    expect(whereSigningKey('github.com', 'github')).toBe('At github.com: Settings → SSH and GPG keys → New SSH key a second time, with Key type "Signing Key", and the same public half.');
    expect(whereSigningKey('gitlab.com', 'gitlab')).toBe('At gitlab.com: Preferences → SSH Keys: the key\'s Usage type must be "Authentication & Signing".');
  });
});

describe('ssh’s answer', () => {
  test('a greeting means the key works, whatever the exit code', () => {
    expect(sshAnswerOf(1, "Hi sam! You've successfully authenticated, but GitHub does not provide shell access.")).toEqual({ answer: 'works', detail: null });
    expect(sshAnswerOf(0, 'Welcome to GitLab, @sam!')).toEqual({ answer: 'works', detail: null });
  });

  test('not added, not reachable, a changed host key, and anything else with its last line', () => {
    expect(sshAnswerOf(255, "Warning: Permanently added 'github.com' (ED25519) to the list of known hosts.\ngit@github.com: Permission denied (publickey).").answer).toBe('not-added');
    expect(sshAnswerOf(255, 'ssh: Could not resolve hostname git.example.org: Name or service not known')).toEqual({ answer: 'unreachable', detail: 'ssh: Could not resolve hostname git.example.org: Name or service not known' });
    expect(sshAnswerOf(null, '')).toEqual({ answer: 'unreachable', detail: null });
    expect(sshAnswerOf(255, '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.').answer).toBe('host-key-changed');
    expect(sshAnswerOf(1, 'something odd')).toEqual({ answer: 'unknown', detail: 'something odd' });
  });

  test('the test is ssh -T as git@host, with the options given', () => {
    expect(sshTestArgs(['-F', 'none'], 'github.com')).toEqual(['-T', '-F', 'none', '-o', 'ConnectTimeout=15', 'git@github.com']);
  });

  test('host keys and fingerprints as ssh-keygen prints them', () => {
    expect(hostKeysFrom('# Host github.com found: line 1 \ngithub.com ED25519 SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU\n')).toEqual([{ type: 'ED25519', fingerprint: 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU' }]);
    expect(fingerprintFrom('256 SHA256:Ab/c+1= kestrel-node n (ED25519)')).toBe('SHA256:Ab/c+1=');
    expect(fingerprintFrom('nothing')).toBeNull();
  });

  test('each answer as a line', () => {
    expect(hostAnswerText('github.com', 'works')).toBe('github.com: the key works');
    expect(hostAnswerText('git.example.org', 'not-added')).toBe('git.example.org: the key is not added there yet');
    expect(hostAnswerText('x.example', 'unreachable', 'timed out')).toBe('x.example: could not be reached (timed out)');
  });
});

describe('the git lines of kestrel-node status', () => {
  test('no key yet: one line, with the command', () => {
    expect(gitStatusLines(gitStatusOf(EMPTY_GIT_SETTINGS, false))).toEqual(['Git: no key of this node\'s yet. Run "kestrel-node git".']);
  });

  test('a key whose file is gone is no key', () => {
    expect(gitStatusOf({ ...EMPTY_GIT_SETTINGS, key: { fingerprint: 'SHA256:abc', madeAt: 1 } }, false).key).toBeNull();
  });

  test('what is still to do, the default and per-host emails, signing, and each tool: by Kestrel or found elsewhere', () => {
    const settings: NodeGitSettings = {
      ...EMPTY_GIT_SETTINGS,
      key: { fingerprint: 'SHA256:abc', madeAt: 1 },
      name: 'Sam Rivera',
      email: 'sam@example.com',
      signing: 'node-key',
      hosts: { 'github.com': { answer: 'works', at: 1, signing: 'registered' }, 'git.example.org': { answer: 'not-added', at: 1, email: 'sam@git.example.org' } },
      tools: { gh: { installed: true, by: 'kestrel', version: '2.96.0', signedIn: ['github.com'], notSignedIn: [] }, glab: { installed: true, by: 'elsewhere', signedIn: [], notSignedIn: ['git.example.org'] } },
    };
    expect(gitStatusLines(gitStatusOf(settings, true))).toEqual([
      'Git: key made (SHA256:abc); not yet accepted at git.example.org; signing key not checked at git.example.org; accepted at github.com; signing key registered at github.com (as "kestrel-node git" last found it)',
      '  Commits: Sam Rivera <sam@example.com>; at git.example.org: sam@git.example.org; signed with this key',
      '  gh 2.96.0, installed by Kestrel, signed in to github.com; glab, found elsewhere on PATH, not signed in to git.example.org',
    ]);
    expect(hostsWithKey(settings)).toEqual(['github.com']);
  });

  test('never "done" where Kestrel could not know: a host not answering is "not checked", and so is signing nobody listed', () => {
    const settings: NodeGitSettings = { ...EMPTY_GIT_SETTINGS, key: { fingerprint: 'SHA256:abc', madeAt: 1 }, signing: 'node-key', hosts: { 'git.example.org': { answer: 'unreachable', at: 1, signing: 'not-registered' } } };
    expect(gitToDoSummary(settings, true)).toBe('key made (SHA256:abc); not checked at git.example.org (unreachable); signing key not registered at git.example.org');
    expect(gitToDoSummary({ ...settings, hosts: {} }, true)).toBe('key made (SHA256:abc); no host checked yet');
    expect(gitToDoSummary(settings, false)).toBe('no key yet; run "kestrel-node git"');
  });

  test('the tools’ sign-ins, named for uninstall with their sign-out commands', () => {
    const settings: NodeGitSettings = { ...EMPTY_GIT_SETTINGS, tools: { gh: { installed: true, signedIn: ['github.com'], notSignedIn: [] }, glab: { installed: false } } };
    expect(toolSignIns(settings)).toEqual([{ label: 'gh at github.com', where: '~/.config/gh', signOut: 'gh auth logout --hostname github.com' }]);
  });
});
