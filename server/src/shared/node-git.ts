// Git on a worker node (docs/designs/worker-nodes.md, section 7), purely: where the node's own key and Kestrel's git
// settings live, what is kept, and the environment Kestrel's git runs in there. The key is made on the node by
// `kestrel node git` and never leaves it; it is never one of the user's ~/.ssh keys. Kestrel's own git calls, and the
// commands its sessions' agents run, get the key, the commit name and email and the signing choice through their
// environment (`GIT_SSH_COMMAND`, and `GIT_CONFIG_*` pairs for the identity, per host, and signing); nothing is
// written into the user's git configuration, so git run by the person on the node is unchanged. The app gets none of it.
import type { KestrelKind } from './host-kind.ts';

export const NODE_GIT_COMMAND = 'kestrel node git';

/** The files of the node's git, all in one folder of Kestrel's, the user's alone. */
export interface NodeGitPaths {
  folder: string;
  /** The private half (ed25519), mode 600. */
  key: string;
  publicKey: string;
  /** Host keys accepted for Kestrel's git, never the user's ~/.ssh/known_hosts. */
  knownHosts: string;
  /** What `kestrel node git` chose and found (`NodeGitSettings`), mode 600. */
  settings: string;
  /** One small git configuration file per host whose commit identity differs from the default (`identityIncludes`). */
  identity: string;
}

export const nodeGitPaths = (dataDir: string): NodeGitPaths => {
  const folder = `${dataDir.replace(/\/+$/, '')}/git`;
  return { folder, key: `${folder}/id_ed25519`, publicKey: `${folder}/id_ed25519.pub`, knownHosts: `${folder}/known_hosts`, settings: `${folder}/git.json`, identity: `${folder}/identity` };
};

/** How a host answered the key, the last time `kestrel node git` asked. */
export type HostAnswer = 'works' | 'not-added' | 'unreachable' | 'host-key-changed' | 'unknown';

/** Whether the node's key is registered for signing at a host: known only when Kestrel registered it or asked the host's tool. */
export type SigningAt = 'registered' | 'not-registered';

export interface HostCheck {
  answer: HostAnswer;
  /** The program that added the key there, when Kestrel ran it. */
  addedBy?: 'gh' | 'glab';
  at: number;
  /** The commit email at this host when it is not the default (read from the host's tool, or typed). */
  email?: string;
  /** The commit name at this host, only when it is not the default. */
  name?: string;
  /** Whether the key is registered for signing there; absent: not checked (Kestrel cannot know without the host's tool). */
  signing?: SigningAt;
}

/** Whether `gh` or `glab` is on the node and signed in to the hosts that matter, asked of the program itself. `by`: Kestrel's tools folder, or elsewhere on PATH. */
export type ToolState = { installed: false } | { installed: true; by?: 'kestrel' | 'elsewhere'; version?: string; signedIn: string[]; notSignedIn: string[] };

export type SigningChoice = 'node-key' | 'off';

/** Kestrel's own git settings on a node: one file, read by the node at start and whenever `kestrel node git` is done. */
export interface NodeGitSettings {
  /** The key, once made: its fingerprint (SHA256:…), so `status` and `uninstall` name it without running anything. */
  key: { fingerprint: string; madeAt: number } | null;
  name: string | null;
  email: string | null;
  /** Null until asked; asked only when a computer of the account signs its commits. */
  signing: SigningChoice | null;
  hosts: Readonly<Record<string, HostCheck>>;
  tools: { gh: ToolState | null; glab: ToolState | null };
}

export const EMPTY_GIT_SETTINGS: NodeGitSettings = { key: null, name: null, email: null, signing: null, hosts: {}, tools: { gh: null, glab: null } };

const NAME_MAX = 200;
const HOSTS_MAX = 50;

const obj = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const textOr = (value: unknown, max = NAME_MAX): string | null => (typeof value === 'string' && value.length > 0 && value.length <= max ? value : null);
/** An identity value as kept: one git would take, or null. */
const identityOr = (value: unknown, what: 'name' | 'email'): string | null => {
  const text = textOr(value);
  return text !== null && identityProblem(text, what) === null ? text : null;
};
const ANSWERS: readonly HostAnswer[] = ['works', 'not-added', 'unreachable', 'host-key-changed', 'unknown'];
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && isHostName(v)).slice(0, HOSTS_MAX) : []);

/** A host name as Kestrel's git may be pointed at: letters, digits, dots and hyphens; never an option or a path. */
export const isHostName = (host: string): boolean => /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(host) && !host.includes('..');

function toolOf(raw: unknown): ToolState | null {
  const r = obj(raw);
  if (!r) return null;
  return r.installed === true ? { installed: true, ...(r.by === 'kestrel' || r.by === 'elsewhere' ? { by: r.by } : {}), ...(typeof r.version === 'string' && /^\d+\.\d+\.\d+$/.test(r.version) ? { version: r.version } : {}), signedIn: strings(r.signedIn), notSignedIn: strings(r.notSignedIn) } : { installed: false };
}

/** The settings file as read, made safe: anything that is not what `kestrel node git` writes is left out. Never throws. */
export function parseNodeGitSettings(text: string | null): NodeGitSettings {
  let raw: unknown = null;
  try {
    raw = text === null ? null : JSON.parse(text);
  } catch {
    raw = null;
  }
  const r = obj(raw);
  if (!r) return EMPTY_GIT_SETTINGS;
  const key = obj(r.key);
  const fingerprint = key && textOr(key.fingerprint, 100);
  const hosts: Record<string, HostCheck> = {};
  for (const [host, check] of Object.entries(obj(r.hosts) ?? {}).slice(0, HOSTS_MAX)) {
    const c = obj(check);
    if (!c || !isHostName(host) || !ANSWERS.includes(c.answer as HostAnswer)) continue;
    const email = identityOr(c.email, 'email');
    const name = identityOr(c.name, 'name');
    hosts[host.toLowerCase()] = {
      answer: c.answer as HostAnswer,
      ...(c.addedBy === 'gh' || c.addedBy === 'glab' ? { addedBy: c.addedBy } : {}),
      at: typeof c.at === 'number' ? c.at : 0,
      ...(email ? { email } : {}),
      ...(name ? { name } : {}),
      ...(c.signing === 'registered' || c.signing === 'not-registered' ? { signing: c.signing } : {}),
    };
  }
  const tools = obj(r.tools) ?? {};
  return {
    key: fingerprint && fingerprint.startsWith('SHA256:') ? { fingerprint, madeAt: typeof key.madeAt === 'number' ? key.madeAt : 0 } : null,
    name: identityOr(r.name, 'name'),
    email: identityOr(r.email, 'email'),
    signing: r.signing === 'node-key' || r.signing === 'off' ? r.signing : null,
    hosts,
    tools: { gh: toolOf(tools.gh), glab: toolOf(tools.glab) },
  };
}

export const nodeGitSettingsText = (settings: NodeGitSettings): string => `${JSON.stringify(settings, null, 2)}\n`;

/** Why git would not take this as a commit name or email, or null when it would. */
export function identityProblem(value: string, what: 'name' | 'email'): string | null {
  const v = value.trim();
  if (!v) return what === 'name' ? 'A name is needed.' : 'An email address is needed.';
  if (v.length > NAME_MAX) return `At most ${NAME_MAX} characters.`;
  // git refuses these in an identity: angle brackets and line breaks.
  if (/[<>\n\r\u0000]/.test(v)) return 'Without angle brackets or line breaks.';
  if (what === 'email' && !/^[^\s@]+@[^\s@]+$/.test(v)) return 'An email address looks like name@example.com.';
  return null;
}

/**
 * ssh's options for Kestrel's git on a node: the node's key only (no agent, no key of the user's, no ssh config file,
 * so nothing of ~/.ssh is used), Kestrel's own known hosts, and never a question. `accept-new` is for the check
 * `kestrel node git` runs, which says which host keys it accepted; git itself trusts only those (`yes`).
 */
export function sshOptions(paths: NodeGitPaths, hostKeys: 'accept-new' | 'yes'): string[] {
  return ['-F', 'none', '-i', paths.key, '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', `UserKnownHostsFile=${paths.knownHosts}`, '-o', `StrictHostKeyChecking=${hostKeys}`, '-o', 'BatchMode=yes'];
}

/** A word for a shell: git runs `GIT_SSH_COMMAND` through one. */
const shellWord = (word: string): string => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

export const gitSshCommand = (paths: NodeGitPaths): string => ['ssh', ...sshOptions(paths, 'yes')].map(shellWord).join(' ');

/** The fixed variables Kestrel sets or once set for git on a node; with `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`, `isKestrelGitEnvKey`. */
export const KESTREL_GIT_ENV_KEYS = ['GIT_SSH_COMMAND', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_CONFIG_COUNT'] as const;

/** Whether a variable is one Kestrel sets for git on a node, so one it set before and no longer sets is taken away. */
export const isKestrelGitEnvKey = (key: string): boolean => (KESTREL_GIT_ENV_KEYS as readonly string[]).includes(key) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key);

/** Git settings given for one run of git, as `-c` would: `GIT_CONFIG_COUNT` and its pairs (git 2.31 and later). */
function configEnv(pairs: readonly (readonly [string, string])[]): Record<string, string> {
  if (pairs.length === 0) return {};
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/** The commit name and email for a repository at `host`: that host's own where one is kept, else the default. Pure. */
export function identityFor(settings: NodeGitSettings, host: string | null): { name: string | null; email: string | null } {
  const at = host ? settings.hosts[host.toLowerCase()] : undefined;
  return { name: at?.name ?? settings.name, email: at?.email ?? settings.email };
}

/** The hosts whose commit identity differs from the default, in order. Pure. */
export const identityHosts = (settings: NodeGitSettings): string[] => Object.keys(settings.hosts).filter((h) => settings.hosts[h]!.email || settings.hosts[h]!.name).sort();

/** The remote addresses of a host's repositories, as git's `hasconfig:remote.*.url:` patterns: scp-like ssh, ssh://, https. */
export const remotePatterns = (host: string): string[] => [`git@${host}:**/**`, `ssh://git@${host}/**`, `https://${host}/**`];

const configValue = (value: string): string => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

/** The file of one host's identity, and what it holds. Pure. */
export function identityIncludes(settings: NodeGitSettings, paths: NodeGitPaths): { path: string; text: string }[] {
  return identityHosts(settings).map((host) => {
    const who = identityFor(settings, host);
    const lines = ['[user]', ...(who.name ? [`\tname = ${configValue(who.name)}`] : []), ...(who.email ? [`\temail = ${configValue(who.email)}`] : [])];
    return { path: `${paths.identity}/${host}.gitconfig`, text: `${lines.join('\n')}\n` };
  });
}

/**
 * What Kestrel's git runs with, beyond the environment it was started in. The app: nothing. A node: its key (once
 * made); the commit name and email (once set), as git settings so a repository's host can change them; and signing,
 * with its own key or explicitly off so a repository that signs does not fail for want of a key on another computer.
 *
 * The commit identity is per host (Matt, 2026-11-27: his address at GitHub is not the one at his GitLab). `repoHost` is
 * the host of the repository the git or the agent works in, when it is known (a session's own repository): its
 * identity is the one given. For every other repository the git run there picks its host's identity itself, by a
 * conditional include per host (`includeIf.hasconfig:remote.*.url:`, git 2.36 and later; `identityIncludes` writes
 * the files), so a project of repositories at two hosts commits to each with that host's address. Pure.
 */
export function kestrelGitEnv(kind: KestrelKind, settings: NodeGitSettings, paths: NodeGitPaths, keyIsThere: boolean, repoHost: string | null = null): Record<string, string> {
  if (kind !== 'node') return {};
  const env: Record<string, string> = {};
  const hasKey = keyIsThere && settings.key !== null;
  if (hasKey) env.GIT_SSH_COMMAND = gitSshCommand(paths);
  const pairs: [string, string][] = [];
  const who = identityFor(settings, repoHost);
  if (who.name && who.email) pairs.push(['user.name', who.name], ['user.email', who.email]);
  for (const file of identityIncludes(settings, paths)) {
    const host = file.path.slice(paths.identity.length + 1, -'.gitconfig'.length);
    for (const pattern of remotePatterns(host)) pairs.push([`includeIf.hasconfig:remote.*.url:${pattern}.path`, file.path]);
  }
  if (settings.signing === 'node-key' && hasKey) pairs.push(['gpg.format', 'ssh'], ['user.signingkey', paths.key], ['commit.gpgsign', 'true']);
  else if (settings.signing === 'off') pairs.push(['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']);
  return { ...env, ...configEnv(pairs) };
}

type Env = Record<string, string | undefined>;

/** `env` with Kestrel's git variables replaced by `git`: the ones it set before and no longer sets are taken away. Pure. */
export function withKestrelGitEnv(env: Env, git: Readonly<Record<string, string>>): Env {
  const rest = Object.fromEntries(Object.entries(env).filter(([key]) => !isKestrelGitEnvKey(key)));
  return { ...rest, ...git };
}
