// What `kestrel node uninstall` decides and says (docs/designs/worker-nodes.md, section 4), purely. It is refused
// while a session's worktree has work that is not pushed, by one rule: uncommitted files (git status) or commits on
// its branch that are on no remote-tracking branch, the two counts Kestrel already takes before it removes a
// worktree after a merge (cleanup/on-merge.ts, git.ts). Git that cannot answer counts as work, never as none.

export interface WorktreeWork {
  sessionId: string;
  title: string;
  /** Files `git status` lists. */
  uncommitted: number;
  /** Commits on the branch that no remote has. */
  unpushed: number;
}

export const hasUnsavedWork = (work: Pick<WorktreeWork, 'uncommitted' | 'unpushed'>): boolean => work.uncommitted > 0 || work.unpushed > 0;

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

function whatIsLeft(work: WorktreeWork): string {
  const parts = [work.uncommitted > 0 ? plural(work.uncommitted, 'uncommitted file', 'uncommitted files') : '', work.unpushed > 0 ? plural(work.unpushed, 'commit not pushed', 'commits not pushed') : ''];
  return parts.filter(Boolean).join(', ');
}

/** Null when nothing would be lost; else the refusal, naming each session and what it would lose. */
export function unsavedWorkRefusal(rows: readonly WorktreeWork[]): string | null {
  const unsaved = rows.filter(hasUnsavedWork);
  if (unsaved.length === 0) return null;
  const named = unsaved.map((w) => `  "${w.title}": ${whatIsLeft(w)}`);
  return [`Not uninstalled: ${plural(unsaved.length, 'session has', 'sessions have')} work that is not pushed, and it would be lost.`, ...named, 'Push it (or discard it in Kestrel), then run "kestrel node uninstall" again. Nothing was changed.'].join('\n');
}

/** What the node did when it left the account. */
export type LeaveOutcome = 'left' | 'not-signed-in';

export function leftText(outcome: LeaveOutcome): string {
  return outcome === 'left'
    ? 'Removed this node from your Kestrel Connect account and signed it out. Another of your devices rotates the account key the next time it connects.'
    : 'This node was not signed in to Kestrel Connect, so there was no account to leave.';
}

/** The word typed to agree, each time it is asked. */
export const CONFIRM_WORD = 'yes';

export const confirmUninstallPrompt = (name: string): string => `This removes ${name} from your account, stops it and deletes it from this computer. Type "${CONFIRM_WORD}" to go on: `;

export const confirmDataPrompt = (path: string): string => `Also delete Kestrel's data folder, ${path} (its sessions' conversations, worktrees and sign-ins)? Type "${CONFIRM_WORD}" to delete it, anything else to keep it: `;

export const agreed = (answer: string | null): boolean => answer?.trim().toLowerCase() === CONFIRM_WORD;

/** An agent signed in on this machine, by its own program, which uninstalling Kestrel leaves alone. */
export interface AgentSignIn {
  label: string;
  /** The folder its sign-in is kept in. */
  where: string;
  /** The command that signs it out. */
  signOut: string;
}

/** The node's own git key (`kestrel node git`), deleted with the node: its fingerprint and the hosts it was added to. */
export interface FarewellGitKey {
  fingerprint: string;
  hosts: readonly string[];
}

export interface Farewell {
  /** The node's git key, when it had one; it is deleted, and may still be listed at the hosts. */
  gitKey?: FarewellGitKey | null;
  /** Public halves of SSH keys in ~/.ssh: a key added to a git host for this node is still there. */
  sshPublicKeys: readonly string[];
  agents: readonly AgentSignIn[];
  /** gh and glab, signed in at hosts by `kestrel node git`: their programs are deleted, their sign-ins are not. */
  tools?: readonly AgentSignIn[];
  /** The data folder, when it was kept. */
  keptData: string | null;
}

/** The last thing uninstall says: what it left on purpose, and what the person may want to remove elsewhere. */
export function farewellLines(f: Farewell): string[] {
  const lines = ['Kestrel’s worker node is uninstalled.'];
  if (f.keptData) lines.push(`Its data folder was kept: ${f.keptData}. Delete it yourself when you no longer need it.`);
  if (f.gitKey) {
    const at = f.gitKey.hosts.length > 0 ? ` It was added at ${f.gitKey.hosts.join(', ')}: delete it there too (GitHub: Settings → SSH and GPG keys; GitLab: Preferences → SSH Keys), by this fingerprint.` : ' If you added it at a git host, delete it there too, by this fingerprint.';
    lines.push(`This node's git key (${f.gitKey.fingerprint}) was deleted from this computer.${at}`);
  }
  if (f.sshPublicKeys.length > 0) {
    lines.push('If you added one of these SSH keys to your git host for this node, delete it there (and the key here, if nothing else uses it):', ...f.sshPublicKeys.map((key) => `  ${key}`));
  }
  if (f.agents.length > 0) {
    lines.push('These agents are still signed in on this machine; each is signed out by its own program:', ...f.agents.map((a) => `  ${a.label} (${a.where}): ${a.signOut}`));
  }
  if (f.tools && f.tools.length > 0) {
    lines.push('gh and glab were deleted, but their sign-ins are still in your home folder; sign them out with the tool before deleting it, or delete the folder named:', ...f.tools.map((t) => `  ${t.label} (${t.where}): ${t.signOut}`));
  }
  return lines;
}
