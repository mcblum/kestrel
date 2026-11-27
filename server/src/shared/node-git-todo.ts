// What is still to do for git on a worker node (docs/designs/worker-nodes.md, section 7), purely, from what
// `kestrel-node git` kept. One rule: the checklist ends with it as a numbered list, and `status` sums it up. Where
// Kestrel cannot know (a host it could not ask, a signing key no tool could list) it says "not checked", never "done".
import { whereSigningKey, wherePasteKey } from './node-git-hosts.ts';
import { hostKindOf, signInCommand, toolForHost, type GitTool } from './node-git-tools.ts';
import { NODE_GIT_COMMAND, type HostCheck, type NodeGitSettings } from './node-git.ts';

export type GitToDo =
  | { kind: 'make-key' }
  | { kind: 'add-key'; host: string }
  /** The account's hosts could not be read: the key goes to each git host its projects use. */
  | { kind: 'add-key-anywhere' }
  | { kind: 'check-host'; host: string; answer: HostCheck['answer'] }
  | { kind: 'register-signing'; host: string; email: string | null }
  | { kind: 'sign-in'; tool: GitTool; host: string; signing: boolean }
  | { kind: 'identity' };

export interface ToDoContext {
  keyIsThere: boolean;
  /** The hosts the account's projects use, or the ones checked before when those could not be read. */
  hosts: readonly string[];
  /** False when the account's hosts could not be read. */
  hostsKnown: boolean;
}

/** The commit email at a host: its own, else the default. */
export const emailAt = (settings: NodeGitSettings, host: string): string | null => settings.hosts[host]?.email ?? settings.email;

/** What is still to do, in the order it is best done. */
export function gitToDo(settings: NodeGitSettings, ctx: ToDoContext): GitToDo[] {
  const out: GitToDo[] = [];
  if (!ctx.keyIsThere) out.push({ kind: 'make-key' });
  else {
    for (const host of ctx.hosts) {
      const answer = settings.hosts[host]?.answer;
      if (!answer || answer === 'not-added') out.push({ kind: 'add-key', host });
      else if (answer !== 'works') out.push({ kind: 'check-host', host, answer });
    }
    if (!ctx.hostsKnown) out.push({ kind: 'add-key-anywhere' });
    if (settings.signing === 'node-key') for (const host of ctx.hosts) if (settings.hosts[host]?.signing !== 'registered') out.push({ kind: 'register-signing', host, email: emailAt(settings, host) });
  }
  for (const host of ctx.hosts) {
    const tool = toolForHost(host);
    const state = settings.tools[tool];
    if (!state?.installed || !state.signedIn.includes(host)) out.push({ kind: 'sign-in', tool, host, signing: settings.signing === 'node-key' });
  }
  if (!settings.name || !settings.email) out.push({ kind: 'identity' });
  return out;
}

/** One item in full, for the checklist's list: the words, and a line of code to copy when there is one. */
export function toDoText(item: GitToDo, publicKey: string | null): { text: string; code?: string } {
  switch (item.kind) {
    case 'make-key':
      return { text: `Make this node's key: run ${NODE_GIT_COMMAND} at a terminal.` };
    case 'add-key':
      return { text: `Add the key at ${item.host}. ${wherePasteKey(item.host, hostKindOf(item.host))} Then run ${NODE_GIT_COMMAND} again to check it.`, ...(publicKey ? { code: publicKey } : {}) };
    case 'add-key-anywhere':
      return {
        text: `Add the key at each git host your account's projects use (GitHub: Settings → SSH and GPG keys → New SSH key; GitLab: Preferences → SSH Keys), then run ${NODE_GIT_COMMAND} again once the node has read your account.`,
        ...(publicKey ? { code: publicKey } : {}),
      };
    case 'check-host':
      return { text: `${item.host} did not let the key be checked (${item.answer === 'unreachable' ? 'it could not be reached' : item.answer === 'host-key-changed' ? 'its host key changed' : 'it did not say'}). Run ${NODE_GIT_COMMAND} again once it can be reached.` };
    case 'register-signing': {
      const email = item.email ? `The commit email there (${item.email}) must be an address ${item.host} has verified, or the commits show as unverified.` : `The commit email there must be an address ${item.host} has verified.`;
      return { text: `Register the key for signing. ${whereSigningKey(item.host, hostKindOf(item.host))} ${email}` };
    }
    case 'sign-in':
      return { text: `Sign ${item.tool} in to ${item.host}, so this node's pull requests, review requests and Autopilot work there:`, code: signInCommand(item.tool, item.host, item.signing) };
    case 'identity':
      return { text: `Set the commit name and email: run ${NODE_GIT_COMMAND} at a terminal.` };
  }
}

/** Per host, what is known of the key there, as `status` sums it up. */
function hostSummary(settings: NodeGitSettings, host: string): string[] {
  const check = settings.hosts[host];
  const key = !check ? `not checked at ${host}` : check.answer === 'works' ? `accepted at ${host}` : check.answer === 'not-added' ? `not yet accepted at ${host}` : `not checked at ${host} (${check.answer === 'unreachable' ? 'unreachable' : check.answer === 'host-key-changed' ? 'its host key changed' : 'no answer'})`;
  if (settings.signing !== 'node-key') return [key];
  const signing = check?.signing === 'registered' ? `signing key registered at ${host}` : check?.signing === 'not-registered' ? `signing key not registered at ${host}` : `signing key not checked at ${host}`;
  return [key, signing];
}

/** `status`'s one line of what is still to do: "key made (SHA256:…); accepted at github.com; signing key not checked at …". */
export function gitToDoSummary(settings: NodeGitSettings, keyIsThere: boolean): string {
  if (!keyIsThere || !settings.key) return `no key yet; run "${NODE_GIT_COMMAND}"`;
  const made = `key made (${settings.key.fingerprint})`;
  const hosts = Object.keys(settings.hosts).sort();
  if (hosts.length === 0) return `${made}; no host checked yet`;
  return [made, ...hosts.flatMap((h) => hostSummary(settings, h))].join('; ');
}
