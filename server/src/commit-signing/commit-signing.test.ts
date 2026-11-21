// Signed commits through a child's sandbox: what is detected, what is let through, and the switch.
// git and gpgconf are fakes here: nothing reads or touches the real ~/.gnupg or git config.
import { describe, expect, it } from 'vitest';
import { signingAccess, sanitizeCommitSigningPrefs } from '../shared/commit-signing.ts';
import { commitSigningRoute } from './api.ts';
import { detectSigning, parseGpgDirs, type DetectDeps } from './detect.ts';
import { CommitSigning } from './prefs.ts';

const GPGCONF = ['sysconfdir:/opt/homebrew/etc/gnupg', 'homedir:/Users/me/.gnupg', 'socketdir:/Users/me/.gnupg', 'dirmngr-socket:/Users/me/.gnupg/S.dirmngr', 'keyboxd-socket:/Users/me/.gnupg/S.keyboxd', 'agent-ssh-socket:/Users/me/.gnupg/S.gpg-agent.ssh', 'agent-extra-socket:/Users/me/.gnupg/S.gpg-agent.extra', 'agent-socket:/Users/me/.gnupg/S.gpg-agent'].join('\n');

/** A machine whose git config is `config` and whose GnuPG is as gpgconf above. */
function machine(config: Record<string, string>, opts: { sockets?: string[]; sshAuthSock?: string } = {}): DetectDeps & { asked: string[][] } {
  const asked: string[][] = [];
  const present = new Set(opts.sockets ?? ['/Users/me/.gnupg/S.gpg-agent', '/Users/me/.gnupg/S.keyboxd', '/tmp/ssh-agent.sock']);
  return {
    asked,
    home: '/Users/me',
    ...(opts.sshAuthSock ? { sshAuthSock: opts.sshAuthSock } : {}),
    exists: (path) => present.has(path),
    run: async (file, args) => {
      asked.push([file, ...args]);
      if (file === 'gpgconf') return GPGCONF;
      const key = args.at(-1)!;
      return config[key] !== undefined ? `${config[key]}\n` : null;
    },
  };
}

describe('what signing needs', () => {
  it('for GnuPG: read its home, and reach gpg-agent and keyboxd only', async () => {
    expect(await detectSigning('/w', machine({ 'commit.gpgsign': 'true', 'user.signingkey': '2C9F' }))).toEqual({
      read: ['/Users/me/.gnupg'],
      sockets: ['/Users/me/.gnupg/S.gpg-agent', '/Users/me/.gnupg/S.keyboxd'],
    });
  });
  it('leaves out a socket that is not there (no keyboxd in use)', async () => {
    expect(await detectSigning('/w', machine({ 'commit.gpgsign': 'true' }, { sockets: ['/Users/me/.gnupg/S.gpg-agent'] }))).toEqual({ read: ['/Users/me/.gnupg'], sockets: ['/Users/me/.gnupg/S.gpg-agent'] });
  });
  it('is nothing when the repository does not sign, and gpgconf is not even asked', async () => {
    const m = machine({ 'commit.gpgsign': 'false' });
    expect(await detectSigning('/w', m)).toBeNull();
    expect(m.asked.some(([file]) => file === 'gpgconf')).toBe(false);
  });
  it('counts signed tags too', async () => {
    expect(await detectSigning('/w', machine({ 'tag.gpgsign': 'true' }))).not.toBeNull();
  });
  it('is nothing when gpg-agent has no socket to reach', async () => {
    expect(await detectSigning('/w', machine({ 'commit.gpgsign': 'true' }, { sockets: [] }))).toBeNull();
  });
  it('for SSH signing: the SSH agent’s socket, and the key file when one is named', async () => {
    const ssh = machine({ 'commit.gpgsign': 'true', 'gpg.format': 'ssh', 'user.signingkey': '~/.ssh/id_ed25519.pub' }, { sshAuthSock: '/tmp/ssh-agent.sock' });
    expect(await detectSigning('/w', ssh)).toEqual({ read: ['/Users/me/.ssh/id_ed25519.pub'], sockets: ['/tmp/ssh-agent.sock'] });
    expect(ssh.asked.some(([file]) => file === 'gpgconf')).toBe(false);
    expect(signingAccess({ signs: true, format: 'ssh', signingKey: 'key::ssh-ed25519 AAAA' }, null, { home: '/h', sshAuthSock: '/s' })).toEqual({ read: [], sockets: ['/s'] });
  });
  it('asks git in the session’s own folder, so the repository’s config counts', async () => {
    const m = machine({ 'commit.gpgsign': 'true' });
    await detectSigning('/data/worktrees/child', m);
    expect(m.asked[0]).toEqual(['git', '-C', '/data/worktrees/child', 'config', '--type=bool', '--get', 'commit.gpgsign']);
  });
  it('reads gpgconf’s list, decoding an escaped colon', () => {
    expect(parseGpgDirs('homedir:/Users/me/odd%3apath\nagent-socket:/s')).toEqual({ homedir: '/Users/me/odd:path', 'agent-socket': '/s' });
  });
});

describe('the Commit signing switch', () => {
  it('is on by default, and off lets nothing through', async () => {
    const signing = new CommitSigning({ detect: machine({ 'commit.gpgsign': 'true' }) });
    expect(await signing.prefs()).toEqual({ allowed: true });
    expect(await signing.accessFor('/w')).toBeDefined();
    await signing.setAllowed(false);
    expect(await signing.accessFor('/w')).toBeUndefined();
    expect(sanitizeCommitSigningPrefs({ allowed: 'no' })).toEqual({ allowed: true });
  });
  it('is read and set through its route, refusing anything but true or false', async () => {
    const signing = new CommitSigning({ detect: machine({}) });
    const route = (method: string, body: Record<string, unknown> = {}) => commitSigningRoute(['api', 'commit-signing'], method, async () => body, signing);
    expect(await route('GET')).toEqual({ status: 200, body: { allowed: true } });
    expect(await route('PATCH', { allowed: false })).toEqual({ status: 200, body: { allowed: false } });
    expect(await route('PATCH', { allowed: 'yes' })).toEqual({ status: 400, body: { error: 'allowed must be true or false.' } });
    expect(await route('POST')).toBeNull();
  });
});
