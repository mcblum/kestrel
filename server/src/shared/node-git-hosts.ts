// The git hosts a node's key must reach, and what is said about each (docs/designs/worker-nodes.md, section 7), purely:
// the hosts are read from the account's projects' repositories (their keys, `host/owner/name`: shared/knowledge.ts
// `repositoryKey`), where to paste the key at each, and how ssh's answer to the key and its host-key lines are read.
// Which tool speaks to a host, and its commands, are shared/node-git-tools.ts.
import { isHostName } from './node-git.ts';
import type { GitTool, HostKind } from './node-git-tools.ts';

/** The hosts of these repository keys, once each, in order. A key that does not start with a host name is skipped. */
export function hostsOfRepositories(keys: readonly string[]): string[] {
  const hosts = keys.map((key) => key.split('/')[0]!.toLowerCase()).filter((host) => isHostName(host) && host.includes('.'));
  return [...new Set(hosts)].sort();
}

/** Where a person pastes the public half so the key may read and push. */
export function wherePasteKey(host: string, kind: HostKind): string {
  if (kind === 'github') return `At ${host}: Settings → SSH and GPG keys → New SSH key, and paste the public half.`;
  return `At ${host}: Preferences → SSH Keys → Add new key, and paste the public half.`;
}

/** Where a person registers the same public half as a signing key, so the host shows the node's commits as verified. */
export function whereSigningKey(host: string, kind: HostKind): string {
  if (kind === 'github') return `At ${host}: Settings → SSH and GPG keys → New SSH key a second time, with Key type "Signing Key", and the same public half.`;
  return `At ${host}: Preferences → SSH Keys: the key's Usage type must be "Authentication & Signing".`;
}

/** The title the key is added under at a host. */
export const keyTitle = (node: string): string => `Kestrel worker node ${node}`.slice(0, 100);

/** What is missing on a node without a tool signed in, for a host. */
export const withoutTool = (tool: GitTool, host: string): string => `Without ${tool} signed in to ${host}, this node's pull requests, review requests and Autopilot are not there for ${host}.`;

/** The test of the key against one host: ssh's own, as `git@host`, with Kestrel's options, taking a new host key. */
export const sshTestArgs = (options: readonly string[], host: string): string[] => ['-T', ...options, '-o', 'ConnectTimeout=15', `git@${host}`];

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** What ssh's answer says of the key at a host. A host's greeting (GitHub exits 1 with it) is read before the code. Pure. */
export function sshAnswerOf(code: number | null, output: string): { answer: 'works' | 'not-added' | 'unreachable' | 'host-key-changed' | 'unknown'; detail: string | null } {
  const text = output.replace(ANSI, '');
  const last = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('Warning: Permanently added')).at(-1) ?? null;
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(text)) return { answer: 'host-key-changed', detail: last };
  if (/successfully authenticated|Welcome to GitLab|Welcome to Gitea|Welcome to Forgejo|logged in as|authenticated via/i.test(text)) return { answer: 'works', detail: null };
  if (/Permission denied \(publickey/i.test(text)) return { answer: 'not-added', detail: null };
  if (code === null || /Could not resolve hostname|Connection timed out|Connection refused|No route to host|Network is unreachable|Operation timed out|Connection closed by/i.test(text)) return { answer: 'unreachable', detail: last };
  return { answer: code === 0 ? 'works' : 'unknown', detail: code === 0 ? null : last };
}

/** A host key line of `ssh-keygen -l -F <host> -f <known_hosts>`: `<host> <TYPE> SHA256:…`. Pure. */
export function hostKeysFrom(output: string): { type: string; fingerprint: string }[] {
  return [...output.matchAll(/^\S+\s+(\S+)\s+(SHA256:\S+)/gm)].map((m) => ({ type: m[1]!, fingerprint: m[2]! }));
}

/** The fingerprint of `ssh-keygen -l -f <key>`: `256 SHA256:… comment (ED25519)`. Pure. */
export const fingerprintFrom = (output: string): string | null => /\b(SHA256:[A-Za-z0-9+/=]+)/.exec(output)?.[1] ?? null;

/** What one host's line says, in the checklist and in `status`. */
export function hostAnswerText(host: string, answer: string, detail: string | null = null): string {
  if (answer === 'works') return `${host}: the key works`;
  if (answer === 'not-added') return `${host}: the key is not added there yet`;
  if (answer === 'unreachable') return `${host}: could not be reached${detail ? ` (${detail})` : ''}`;
  if (answer === 'host-key-changed') return `${host}: its host key is not the one Kestrel accepted before. Check it with the host's published fingerprints; if it really changed, delete its line from Kestrel's known hosts and run kestrel node git again`;
  return `${host}: did not say whether the key works${detail ? ` (${detail})` : ''}`;
}
