import { describe, expect, test } from 'vitest';
import {
  addKeyCommand,
  apiArgs,
  emailChoice,
  githubEmails,
  githubScopes,
  gitlabEmails,
  matchingKeys,
  parseToolPins,
  signInArgs,
  signInEnv,
  signInWhy,
  toolPinsOf,
  toolPinsText,
  toolVersionFrom,
} from './node-git-tools.ts';

describe('the pinned gh and glab', () => {
  test('one version each, a published archive and its checksum per architecture, carried in the bundle as written', () => {
    const pins = toolPinsOf();
    expect(pins.gh.version).toBe('2.96.0');
    expect(pins.gh.assets.x64).toEqual({ url: 'https://github.com/cli/cli/releases/download/v2.96.0/gh_2.96.0_linux_amd64.tar.gz', sha256: '83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60', inArchive: 'gh_2.96.0_linux_amd64/bin/gh' });
    expect(pins.glab.assets.arm64).toEqual({ url: 'https://gitlab.com/gitlab-org/cli/-/releases/v1.130.0/downloads/glab_1.130.0_linux_arm64.tar.gz', sha256: '062d53acb0f2cbcc79a014600df1aa0fb440bb3a08a5d4900d3b49b553b22767', inArchive: 'bin/glab' });
    expect(parseToolPins(toolPinsText(pins))).toEqual(pins);
  });

  test('a bundle file that is not what the build writes is not read', () => {
    const pins = toolPinsOf();
    expect(parseToolPins(null)).toBeNull();
    expect(parseToolPins('{')).toBeNull();
    expect(parseToolPins(JSON.stringify({ ...pins, gh: { ...pins.gh, version: 'latest' } }))).toBeNull();
    expect(parseToolPins(JSON.stringify({ ...pins, glab: { ...pins.glab, assets: { ...pins.glab.assets, x64: { ...pins.glab.assets.x64, sha256: 'abc' } } } }))).toBeNull();
    expect(parseToolPins(JSON.stringify({ ...pins, glab: { ...pins.glab, assets: { ...pins.glab.assets, x64: { ...pins.glab.assets.x64, inArchive: '../bin/glab' } } } }))).toBeNull();
    expect(parseToolPins(JSON.stringify({ ...pins, gh: { ...pins.gh, assets: { ...pins.gh.assets, x64: { ...pins.gh.assets.x64, url: 'http://example.com/gh.tgz' } } } }))).toBeNull();
  });

  test('the version a tool says, whatever words are around it', () => {
    expect(toolVersionFrom('gh version 2.96.0 (2026-11-20)\nhttps://github.com/cli/cli/releases/tag/v2.96.0')).toBe('2.96.0');
    expect(toolVersionFrom('glab 1.130.0 (abc1234)')).toBe('1.130.0');
    expect(toolVersionFrom('nothing')).toBeNull();
  });
});

describe('each tool’s own sign-in, exactly', () => {
  test('gh: the device flow, ssh for git, no key of its own, and exactly the scopes Kestrel uses; the signing scope only when signing', () => {
    expect(signInArgs('gh', 'github.com', false)).toEqual(['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'ssh', '--skip-ssh-key', '--web', '--scopes', 'write:public_key,user:email']);
    expect(signInArgs('gh', 'github.com', true)).toEqual(['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'ssh', '--skip-ssh-key', '--web', '--scopes', 'write:public_key,write:ssh_signing_key,user:email']);
    expect(githubScopes(true).map((s) => s.scope)).toEqual(['write:public_key', 'write:ssh_signing_key', 'user:email']);
    // No browser is opened on the node: gh prints the address and the code.
    expect(signInEnv('gh')).toEqual({ GH_BROWSER: 'true' });
  });

  test('glab: the device flow at gitlab.com; elsewhere glab asks for a token itself, and Kestrel says where to make one', () => {
    expect(signInArgs('glab', 'gitlab.com', true)).toEqual(['auth', 'login', '--hostname', 'gitlab.com', '--git-protocol', 'ssh', '--device']);
    expect(signInArgs('glab', 'git.example.org', true)).toEqual(['auth', 'login', '--hostname', 'git.example.org', '--git-protocol', 'ssh']);
    expect(signInEnv('glab')).toEqual({});
    expect(signInWhy('glab', 'git.example.org', false)).toBe(
      'glab signs in to git.example.org with a personal access token: make one at https://git.example.org/-/user_settings/personal_access_tokens with the api scope, then paste it when glab asks for it. Kestrel never sees it.',
    );
  });

  test('no token is ever an argument: not in a sign-in, an API call or adding a key', () => {
    const all = [signInArgs('gh', 'github.com', true), signInArgs('glab', 'gitlab.com', true), signInArgs('glab', 'git.example.org', true), apiArgs('github.com', 'user/emails'), addKeyCommand('gh', 'github.com', '/k.pub', 't', 'auth').args].flat();
    expect(all.some((a) => /token|--with-token|--stdin|-t$/.test(a))).toBe(false);
  });
});

describe('adding the key, and finding it there already', () => {
  test('gh: two entries, one per use, the host in its own variable; glab: one entry, for both when signing', () => {
    expect(addKeyCommand('gh', 'github.com', '/k.pub', 'Kestrel worker node n', 'auth')).toEqual({ file: 'gh', args: ['ssh-key', 'add', '/k.pub', '--title', 'Kestrel worker node n', '--type', 'authentication'], env: { GH_HOST: 'github.com' } });
    expect(addKeyCommand('gh', 'github.com', '/k.pub', 't', 'signing').args).toEqual(['ssh-key', 'add', '/k.pub', '--title', 't', '--type', 'signing']);
    expect(addKeyCommand('glab', 'git.example.org', '/k.pub', 't', 'auth_and_signing')).toEqual({ file: 'glab', args: ['ssh-key', 'add', '/k.pub', '--title', 't', '--usage-type', 'auth_and_signing'], env: { GITLAB_HOST: 'git.example.org' } });
  });

  test('a listed key is this node’s by its type and body, whatever its comment or title', () => {
    const mine = 'ssh-ed25519 AAAAmine kestrel-node n';
    expect(matchingKeys([{ key: 'ssh-ed25519 AAAAmine', title: 'x', usage_type: 'auth' }, { key: 'ssh-ed25519 AAAAother' }], mine)).toEqual([{ usage: 'auth' }]);
    expect(matchingKeys({ message: '403 Forbidden' }, mine)).toEqual([]);
  });
});

describe('the commit address at a host', () => {
  const GITHUB = [
    { email: 'sam@example.com', verified: true, primary: true },
    { email: 'sam@personal.example', verified: true, primary: false },
    { email: 'old@example.net', verified: false, primary: false },
  ];

  test('only verified addresses, the primary marked; GitLab’s commit email first', () => {
    expect(githubEmails(GITHUB)).toEqual([
      { email: 'sam@example.com', preferred: true },
      { email: 'sam@personal.example', preferred: false },
    ]);
    expect(gitlabEmails({ email: 'sam@example.com', commit_email: 'sam@work.example' }, [{ email: 'two@example.org', confirmed_at: '2026-01-01' }, { email: 'no@example.org', confirmed_at: null }])).toEqual([
      { email: 'sam@work.example', preferred: true },
      { email: 'sam@example.com', preferred: false },
      { email: 'two@example.org', preferred: false },
    ]);
  });

  test('the default when the host verified it; else the only one; else asked, offering the host’s own; never an unverified one', () => {
    const verified = githubEmails(GITHUB);
    expect(emailChoice(verified, 'SAM@personal.example')).toEqual({ email: 'sam@personal.example' });
    expect(emailChoice(verified, 'old@example.net')).toEqual({ ask: verified, offer: 'sam@example.com' });
    expect(emailChoice(verified.slice(1), null)).toEqual({ email: 'sam@personal.example' });
    expect(emailChoice([], 'sam@example.com')).toEqual({ none: true });
  });
});
