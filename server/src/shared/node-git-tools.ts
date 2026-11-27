// gh and glab on a worker node (docs/designs/worker-nodes.md, section 7), purely: the version of each `kestrel-node git`
// installs, the published archive and its checksum, which tool speaks to which host (the pull-request code's one rule,
// `gitHostKind`), the tools' own sign-ins with exactly the scopes Kestrel needs, the API calls that list keys and read
// verified addresses, and how an address is chosen from what a host answers. The tools go into Kestrel's tools folder
// (`~/.kestrel/tools`, programs only), never globally and never with an administrator. A token never passes through
// Kestrel: each tool's sign-in is the tool's own, run with the person's terminal, and the API answers read are a key
// list and a list of addresses with their verified and primary flags.
//
// The pins are written into the bundle at build time (`tools.json`, by make-node-bundle.mjs from `toolPinsOf`), as the
// agents' are; a checkout reads the same function. Each checksum is the one the release publishes (gh's
// `gh_<v>_checksums.txt`, glab's `checksums.txt`), copied here when the pin is moved, and the download is checked
// against it before anything is unpacked. Erasable TypeScript only: the build script imports this file.
import { gitHostKind, type HostKind as PullRequestHostKind } from './host-terms.ts';

export type GitTool = 'gh' | 'glab';
export const GIT_TOOLS: readonly GitTool[] = ['gh', 'glab'];

/** The architectures a node bundle is built for, as Node names them. */
export type ToolArch = 'x64' | 'arm64';

export interface ToolAsset {
  url: string;
  sha256: string;
  /** The program's path inside the archive. */
  inArchive: string;
}

export interface ToolPin {
  version: string;
  assets: Readonly<Record<ToolArch, ToolAsset>>;
}

export type ToolPins = Readonly<Record<GitTool, ToolPin>>;

/** The file in the bundle, beside `VERSION` and `agents.json`. */
export const TOOL_PINS_FILE = 'tools.json';

const GH_VERSION = '2.96.0';
const GLAB_VERSION = '1.130.0';
const GH_ARCH: Record<ToolArch, string> = { x64: 'amd64', arm64: 'arm64' };

const ghAsset = (arch: ToolArch, sha256: string): ToolAsset => ({
  url: `https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${GH_ARCH[arch]}.tar.gz`,
  sha256,
  inArchive: `gh_${GH_VERSION}_linux_${GH_ARCH[arch]}/bin/gh`,
});
const glabAsset = (arch: ToolArch, sha256: string): ToolAsset => ({
  url: `https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_${GH_ARCH[arch]}.tar.gz`,
  sha256,
  inArchive: 'bin/glab',
});

/** The versions `kestrel-node git` installs, from the releases' published checksum files (checked 2026-11-27). */
export function toolPinsOf(): ToolPins {
  return {
    gh: {
      version: GH_VERSION,
      assets: {
        x64: ghAsset('x64', '83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60'),
        arm64: ghAsset('arm64', '06f86ec7103d41993b76cd78072f43595c34aaa56506d971d9860e67140bf909'),
      },
    },
    glab: {
      version: GLAB_VERSION,
      assets: {
        x64: glabAsset('x64', 'ce06313b2075af25180cd195ab3496d42bc5857c85a1c12ba996838dfe9d822c'),
        arm64: glabAsset('arm64', '062d53acb0f2cbcc79a014600df1aa0fb440bb3a08a5d4900d3b49b553b22767'),
      },
    },
  };
}

export const toolPinsText = (pins: ToolPins): string => `${JSON.stringify(pins, null, 2)}\n`;

const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const ARCHIVE_PATH = /^[\w.-]+(?:\/[\w.-]+)*$/;

function assetOf(raw: unknown): ToolAsset | null {
  const a = raw as Partial<ToolAsset> | null;
  if (!a || typeof a !== 'object') return null;
  if (typeof a.url !== 'string' || !/^(https|file):\/\//.test(a.url)) return null;
  if (typeof a.sha256 !== 'string' || !SHA256.test(a.sha256)) return null;
  if (typeof a.inArchive !== 'string' || !ARCHIVE_PATH.test(a.inArchive) || a.inArchive.split('/').includes('..')) return null;
  return { url: a.url, sha256: a.sha256, inArchive: a.inArchive };
}

function pinOf(raw: unknown): ToolPin | null {
  const p = raw as { version?: unknown; assets?: Record<string, unknown> } | null;
  if (!p || typeof p !== 'object' || typeof p.version !== 'string' || !VERSION.test(p.version) || !p.assets) return null;
  const x64 = assetOf(p.assets.x64);
  const arm64 = assetOf(p.assets.arm64);
  return x64 && arm64 ? { version: p.version, assets: { x64, arm64 } } : null;
}

/** The pins a bundle carries, or null when the file is missing or not what the build writes. Never throws. */
export function parseToolPins(text: string | null): ToolPins | null {
  if (text === null) return null;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const gh = pinOf(raw.gh);
    const glab = pinOf(raw.glab);
    return gh && glab ? { gh, glab } : null;
  } catch {
    return null;
  }
}

/** The architecture of this machine as the pins name it, or null where no tool is pinned. */
export const toolArchOf = (arch: string): ToolArch | null => (arch === 'x64' || arch === 'arm64' ? arch : null);

/** The version a tool prints for `--version` ("gh version 2.96.0 (…)", "glab 1.130.0 (…)"), or null. */
export const toolVersionFrom = (output: string): string | null => /\b(\d+\.\d+\.\d+)\b/.exec(output)?.[1] ?? null;

/** The tool that speaks to a host, by the pull-request code's one rule: GitHub's own hosts are gh's; every other is glab's. */
export const toolForHost = (host: string): GitTool => (gitHostKind(host) === 'github' ? 'gh' : 'glab');

/** What kind of host it is, for the words said about it. */
export type HostKind = PullRequestHostKind;
export const hostKindOf = (host: string): HostKind => gitHostKind(host);

export const TOOL_LABEL: Readonly<Record<GitTool, string>> = { gh: 'GitHub CLI (gh)', glab: 'GitLab CLI (glab)' };

/**
 * The scopes gh asks GitHub for, exactly what Kestrel then does with it: add this node's key (`write:public_key`, which
 * also lists the keys, so a key is never added twice), read the account's verified addresses (`user:email`), and, only
 * when commits here are signed, register the key for signing (`write:ssh_signing_key`). gh adds its own minimum
 * (`repo`, `read:org`, `gist`), which its pull-request commands need.
 */
export function githubScopes(signing: boolean): { scope: string; why: string }[] {
  return [
    { scope: 'write:public_key', why: "add this node's key" },
    ...(signing ? [{ scope: 'write:ssh_signing_key', why: 'register it for signing' }] : []),
    { scope: 'user:email', why: 'read your verified email addresses' },
  ];
}

/** gitlab.com signs glab in by the device flow; any other GitLab with a personal access token typed into glab. */
export const glabSignsInByDevice = (host: string): boolean => host === 'gitlab.com';

/** Where a personal access token is made at a self-hosted GitLab (GitLab 16 and later). */
export const gitlabTokenPage = (host: string): string => `https://${host}/-/user_settings/personal_access_tokens`;

/**
 * A tool's own sign-in, run with the person's terminal: the arguments exactly. gh: the device flow (`--web`, with
 * `GH_BROWSER` set so no browser is opened on the node; gh prints the code and the address), ssh for git, no key of
 * gh's own (`--skip-ssh-key`: the node's key is Kestrel's), and the scopes above. glab: the device flow at gitlab.com;
 * elsewhere glab asks for a token itself, so Kestrel never sees it.
 */
export function signInArgs(tool: GitTool, host: string, signing: boolean): string[] {
  if (tool === 'gh') return ['auth', 'login', '--hostname', host, '--git-protocol', 'ssh', '--skip-ssh-key', '--web', '--scopes', githubScopes(signing).map((s) => s.scope).join(',')];
  return ['auth', 'login', '--hostname', host, '--git-protocol', 'ssh', ...(glabSignsInByDevice(host) ? ['--device'] : [])];
}

/** The environment a sign-in runs in, beside the terminal's: gh opens no browser here (it prints the address instead). */
export const signInEnv = (tool: GitTool): Record<string, string> => (tool === 'gh' ? { GH_BROWSER: 'true' } : {});

/** The sign-in as the person would type it. */
export const signInCommand = (tool: GitTool, host: string, signing: boolean): string => [tool, ...signInArgs(tool, host, signing)].join(' ');

/** The one line said before a sign-in: what it asks for and why, and where the person goes. */
export function signInWhy(tool: GitTool, host: string, signing: boolean): string {
  if (tool === 'gh') {
    const scopes = githubScopes(signing).map((s) => `${s.scope} (${s.why})`).join(', ');
    return `gh signs in to ${host} by a code: it prints the code, you open https://${host}/login/device on any device and type it there. It asks for ${scopes}.`;
  }
  if (glabSignsInByDevice(host)) return `glab signs in to ${host} by a code: it prints the code and the address to open on any device. It asks for the scopes glab's own application uses, which include api.`;
  return `glab signs in to ${host} with a personal access token: make one at ${gitlabTokenPage(host)} with the api scope, then paste it when glab asks for it. Kestrel never sees it.`;
}

/** A tool's question whether it is signed in to a host: it answers by its exit code, and its output is never shown. */
export const authStatusArgs = (_tool: GitTool, host: string): string[] => ['auth', 'status', '--hostname', host];

/** A tool's sign-out at a host, said at uninstall. */
export const signOutCommand = (tool: GitTool, host: string): string => `${tool} auth logout --hostname ${host}`;

/** An API call as run: `gh api --hostname <host> <path>` and the same for glab. Read-only. */
export const apiArgs = (host: string, path: string): string[] => ['api', '--hostname', host, path];

export type KeyUse = 'auth' | 'signing' | 'auth_and_signing';

/** The tool's command to add the key. gh adds a signing key as a second entry; glab adds one entry for both when signing. */
export function addKeyCommand(tool: GitTool, host: string, publicKey: string, title: string, use: KeyUse): { file: GitTool; args: string[]; env: Record<string, string> } {
  if (tool === 'gh') return { file: 'gh', args: ['ssh-key', 'add', publicKey, '--title', title, '--type', use === 'signing' ? 'signing' : 'authentication'], env: { GH_HOST: host } };
  return { file: 'glab', args: ['ssh-key', 'add', publicKey, '--title', title, '--usage-type', use === 'signing' ? 'signing' : use], env: { GITLAB_HOST: host } };
}

/** The API paths read at a host: its key list, its signing keys (GitHub keeps them apart), and its addresses. */
export const KEYS_PATH: Readonly<Record<GitTool, string>> = { gh: 'user/keys', glab: 'user/keys' };
export const SIGNING_KEYS_PATH = 'user/ssh_signing_keys';
export const EMAILS_PATH: Readonly<Record<GitTool, string>> = { gh: 'user/emails', glab: 'user/emails' };
/** GitLab's own user: its primary and commit addresses (both confirmed by GitLab). */
export const GITLAB_USER_PATH = 'user';

/** A key as the type and its base64, the comment dropped: how two public halves are compared. */
export const keyBody = (line: string): string => line.trim().split(/\s+/).slice(0, 2).join(' ');

export interface ListedKey {
  /** GitLab's usage type; GitHub keeps signing keys in their own list. */
  usage: 'auth' | 'signing' | 'auth_and_signing' | null;
}

/** The entries of a host's key list that are this node's key, by its public half. Anything that is not a list is none. */
export function matchingKeys(answer: unknown, publicKey: string): ListedKey[] {
  if (!Array.isArray(answer)) return [];
  const mine = keyBody(publicKey);
  return answer
    .filter((k): k is { key: string; usage_type?: unknown } => typeof k === 'object' && k !== null && typeof (k as { key?: unknown }).key === 'string' && keyBody((k as { key: string }).key) === mine)
    .map((k) => ({ usage: k.usage_type === 'auth' || k.usage_type === 'signing' || k.usage_type === 'auth_and_signing' ? k.usage_type : null }));
}

/** An address a host has verified, and whether it is the one the host says commits use (GitLab's commit email, GitHub's primary). */
export interface HostEmail {
  email: string;
  preferred: boolean;
}

const isEmail = (value: unknown): value is string => typeof value === 'string' && /^[^\s@<>]+@[^\s@<>]+$/.test(value) && value.length <= 200;

/** GitHub's `user/emails`: only the verified ones, the primary marked. Never throws. */
export function githubEmails(answer: unknown): HostEmail[] {
  if (!Array.isArray(answer)) return [];
  return answer
    .filter((e): e is { email: string; verified: boolean; primary?: boolean } => typeof e === 'object' && e !== null && isEmail((e as { email?: unknown }).email) && (e as { verified?: unknown }).verified === true)
    .map((e) => ({ email: e.email, preferred: e.primary === true }));
}

/**
 * GitLab's `user` and `user/emails`: the commit email when set (else the primary), the primary, and every confirmed
 * secondary address, once each. GitLab confirms an account's primary address before it can be used.
 */
export function gitlabEmails(user: unknown, emails: unknown): HostEmail[] {
  const u = (typeof user === 'object' && user !== null ? user : {}) as { email?: unknown; commit_email?: unknown };
  const preferred = isEmail(u.commit_email) ? u.commit_email : isEmail(u.email) ? u.email : null;
  const all = [
    ...(isEmail(u.commit_email) ? [u.commit_email] : []),
    ...(isEmail(u.email) ? [u.email] : []),
    ...(Array.isArray(emails) ? emails.filter((e) => typeof e === 'object' && e !== null && isEmail((e as { email?: unknown }).email) && Boolean((e as { confirmed_at?: unknown }).confirmed_at)).map((e) => (e as { email: string }).email) : []),
  ];
  return [...new Set(all)].map((email) => ({ email, preferred: email === preferred }));
}

/**
 * Which address to commit with at a host, from its verified ones: the default when the host verified it; else the only
 * one; else the person is asked, with the host's preferred one offered. Never one the host did not verify.
 */
export function emailChoice(verified: readonly HostEmail[], fallback: string | null): { email: string } | { ask: HostEmail[]; offer: string } | { none: true } {
  if (verified.length === 0) return { none: true };
  if (fallback && verified.some((e) => e.email.toLowerCase() === fallback.toLowerCase())) return { email: verified.find((e) => e.email.toLowerCase() === fallback.toLowerCase())!.email };
  if (verified.length === 1) return { email: verified[0]!.email };
  return { ask: [...verified], offer: (verified.find((e) => e.preferred) ?? verified[0]!).email };
}

/** Where a tool's sign-in lives, named at uninstall (never opened). */
export const TOOL_CONFIG_SHOWN: Readonly<Record<GitTool, string>> = { gh: '~/.config/gh', glab: '~/.config/glab-cli' };
