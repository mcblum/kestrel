// Signed commits inside a child's sandbox (Settings → Workflow → Commit signing; Matt, 2026-11-19:
// a signed `git commit` in a confined Claude child must not need the outside-the-sandbox card).
// When the session's repository signs commits, its sandbox gets exactly what signing needs and
// nothing more: read access to the signing program's home, and a connection to its agent's socket.
// Pure: the server works out the paths (commit-signing/detect.ts); the Claude adapter adds them to
// the sandbox (agents/claude/sandbox.ts).

/** What a sandbox lets through for signing. */
export interface SigningAccess {
  /** Folders or files commands may read (GnuPG's home; an SSH signing key file). */
  read: string[];
  /** Unix sockets commands may connect to (gpg-agent's, keyboxd's; the SSH agent's). */
  sockets: string[];
}

export interface CommitSigningPrefs {
  /** Let a confined session's commands reach the signing agent. On by default. */
  allowed: boolean;
}

export const DEFAULT_COMMIT_SIGNING_PREFS: CommitSigningPrefs = { allowed: true };

/** Stored or sent prefs made safe: anything that is not exactly `false` leaves it on. */
export function sanitizeCommitSigningPrefs(value: unknown): CommitSigningPrefs {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return { allowed: v.allowed !== false };
}

/** How the repository signs, from its git config (global and its own). */
export interface SigningConfig {
  /** `commit.gpgsign` or `tag.gpgsign` is on. */
  signs: boolean;
  /** `gpg.format`: openpgp (the default), x509 or ssh. */
  format: string;
  /** `user.signingkey`, when set. */
  signingKey: string | null;
}

/** GnuPG's own folders (`gpgconf --list-dirs`), the ones signing uses. */
export interface GpgDirs {
  homedir?: string;
  'agent-socket'?: string;
  'keyboxd-socket'?: string;
}

/** An SSH signing key given as a file (`~/.ssh/id_ed25519.pub`), not a literal key (`key::…`, `ssh-ed25519 …`). */
function keyFile(signingKey: string | null, home: string): string | null {
  if (!signingKey) return null;
  if (signingKey.startsWith('~/')) return `${home}/${signingKey.slice(2)}`;
  return signingKey.startsWith('/') ? signingKey : null;
}

/**
 * What signing needs, or null when the repository does not sign or nothing can be worked out.
 * OpenPGP and X.509 (both GnuPG): read GnuPG's home, connect to gpg-agent (it holds the secret key
 * and asks for the passphrase itself, outside the sandbox) and to keyboxd (the public keys, when
 * GnuPG uses it). SSH: connect to the SSH agent, and read the key file when one is named. Nothing is
 * writable: gpg's lock files and `random_seed` stay outside (see the design doc).
 */
export function signingAccess(config: SigningConfig, gpg: GpgDirs | null, env: { home: string; sshAuthSock?: string }): SigningAccess | null {
  if (!config.signs) return null;
  if (config.format === 'ssh') {
    const file = keyFile(config.signingKey, env.home);
    const sockets = env.sshAuthSock ? [env.sshAuthSock] : [];
    return sockets.length || file ? { read: file ? [file] : [], sockets } : null;
  }
  if (config.format !== 'openpgp' && config.format !== 'x509') return null;
  if (!gpg?.homedir || !gpg['agent-socket']) return null;
  return { read: [gpg.homedir], sockets: [gpg['agent-socket'], ...(gpg['keyboxd-socket'] ? [gpg['keyboxd-socket']] : [])] };
}
