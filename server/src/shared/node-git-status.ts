// What a node says about its git, in `kestrel node status` and when it is uninstalled, purely, from what
// `kestrel node git` kept (shared/node-git.ts). Nothing is run to say it: the hosts and tools are as the checklist last
// found them, and it says so. What is still to do is summed up by the checklist's own rule (node-git-todo.ts).
import { gitToDo, gitToDoSummary } from './node-git-todo.ts';
import { GIT_TOOLS, signOutCommand, TOOL_CONFIG_SHOWN, type GitTool } from './node-git-tools.ts';
import { NODE_GIT_COMMAND, type HostCheck, type NodeGitSettings, type SigningChoice, type ToolState } from './node-git.ts';

export interface NodeGitStatus {
  /** The key's fingerprint, when it is made and its file is there. */
  key: string | null;
  hosts: { host: string; answer: HostCheck['answer']; signing?: HostCheck['signing']; email?: string; name?: string }[];
  identity: { name: string; email: string } | null;
  signing: SigningChoice | null;
  tools: { gh: ToolState | null; glab: ToolState | null };
  /** "key made; accepted at github.com; signing key not checked at …" (node-git-todo.ts). */
  summary: string;
  /**
   * How many items the checklist's still-to-do list has for the hosts checked so far (`gitToDo`), so `kestrel node configure` can
   * tell whether git is done. Absent from a node older than `setup`, which is read as: done once the key is made.
   */
  left?: number;
}

/** Pure: the git part of the status. */
export function gitStatusOf(settings: NodeGitSettings, keyIsThere: boolean): NodeGitStatus {
  return {
    key: keyIsThere && settings.key ? settings.key.fingerprint : null,
    hosts: Object.entries(settings.hosts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([host, c]) => ({ host, answer: c.answer, ...(c.signing ? { signing: c.signing } : {}), ...(c.email ? { email: c.email } : {}), ...(c.name ? { name: c.name } : {}) })),
    identity: settings.name && settings.email ? { name: settings.name, email: settings.email } : null,
    signing: settings.signing,
    tools: settings.tools,
    summary: gitToDoSummary(settings, keyIsThere && settings.key !== null),
    left: gitToDo(settings, { keyIsThere: keyIsThere && settings.key !== null, hosts: Object.keys(settings.hosts).sort(), hostsKnown: true }).length,
  };
}

/** One tool as `status` says it: where it came from, and where it is signed in. */
export function toolText(tool: GitTool, state: ToolState | null): string {
  if (!state) return `${tool} not checked`;
  if (!state.installed) return `${tool} not installed`;
  const what = `${tool}${state.version ? ` ${state.version}` : ''}${state.by === 'kestrel' ? ', installed by Kestrel' : state.by === 'elsewhere' ? ', found elsewhere on PATH' : ''}`;
  const signedIn = state.signedIn.length > 0 ? `signed in to ${state.signedIn.join(', ')}` : '';
  const not = state.notSignedIn.length > 0 ? `not signed in to ${state.notSignedIn.join(', ')}` : '';
  const where = [signedIn, not].filter(Boolean).join(', ') || 'not signed in';
  return `${what}, ${where}`;
}

/** The commit identity: the default, and each host's own address (and name) where it differs. */
function whoText(git: NodeGitStatus): string {
  if (!git.identity) return 'no commit name and email yet';
  const own = git.hosts.filter((h) => h.email || h.name).map((h) => `at ${h.host}: ${h.name ? `${h.name} <${h.email ?? git.identity!.email}>` : h.email}`);
  return [`${git.identity.name} <${git.identity.email}>`, ...own].join('; ');
}

/** Pure: the git lines for a terminal. */
export function gitStatusLines(git: NodeGitStatus): string[] {
  if (!git.key) return [`Git: no key of this node's yet. Run "${NODE_GIT_COMMAND}".`];
  const signs = git.signing === 'node-key' ? '; signed with this key' : git.signing === 'off' ? '; not signed' : '';
  return [
    `Git: ${git.summary} (as "${NODE_GIT_COMMAND}" last found it)`,
    `  Commits: ${whoText(git)}${signs}`,
    `  ${GIT_TOOLS.map((t) => toolText(t, git.tools[t])).join('; ')}`,
  ];
}

/** The hosts the key was added to (by Kestrel through gh or glab, or found working there): to delete it from at uninstall. */
export const hostsWithKey = (settings: NodeGitSettings): string[] => Object.entries(settings.hosts).filter(([, c]) => c.answer === 'works' || c.addedBy).map(([host]) => host);

/** The tools' sign-ins left on this machine, with their sign-out commands: named at uninstall, never opened. */
export function toolSignIns(settings: NodeGitSettings): { label: string; where: string; signOut: string }[] {
  return GIT_TOOLS.flatMap((tool) => {
    const state = settings.tools[tool];
    return state?.installed ? state.signedIn.map((host) => ({ label: `${tool} at ${host}`, where: TOOL_CONFIG_SHOWN[tool], signOut: signOutCommand(tool, host) })) : [];
  });
}
