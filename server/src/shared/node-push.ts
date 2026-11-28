// A worker node pushes its sessions' branches (worker-nodes.md section 9.3). Nobody sits at a node, so a commit left
// there is work nobody can get: when a turn ends, the session's own branch goes to the same name on `origin`. One
// pure step decides (`nodePushStep`); the runtime only carries it out (runtime/node-push.ts), after the turn, never
// blocking the next. A desktop never pushes: there the person does.
//
// The node's Projects settings are stored beside the rule they switch: whether the node mirrors every project of the
// account or clones one only when a session starts in it, and whether it pushes. They are two keys of the closed list
// another computer may change (`NODE_SETTINGS` in shared/node-settings.ts, which has their values and words), kept
// as one setting of their own through the Persistence facade (project-clone/prefs.ts), so a value stored before the
// list existed is still the value read.
import type { KestrelKind } from './host-kind.ts';
import { MIRROR_MODES, type MirrorMode } from './node-settings.ts';

export { MIRROR_MODE_LABEL, MIRROR_MODES, PUSH_LABEL, type MirrorMode } from './node-settings.ts';

export interface NodeProjectPrefs {
  projects: MirrorMode;
  push: boolean;
}

export const DEFAULT_NODE_PROJECT_PREFS: NodeProjectPrefs = { projects: 'every', push: true };

/** Stored settings as read back: anything unknown is the default for that part. */
export function sanitizeNodeProjectPrefs(value: unknown): NodeProjectPrefs {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return {
    projects: MIRROR_MODES.includes(v.projects as MirrorMode) ? (v.projects as MirrorMode) : DEFAULT_NODE_PROJECT_PREFS.projects,
    push: typeof v.push === 'boolean' ? v.push : DEFAULT_NODE_PROJECT_PREFS.push,
  };
}

/** What the step needs to know, as plain values. */
export interface NodePushFacts {
  kind: KestrelKind;
  /** The node's "Push each session's branch when a turn ends". */
  on: boolean;
  /** The session: its own branch (null when it has none), and what makes a branch not its own to push. */
  session: { branch: string | null; hostId?: string; review?: unknown; aside?: unknown };
  /** The branch its worktree was cut from; null when unknown. */
  base: string | null;
  /** Its repository has an `origin`. */
  origin: boolean;
  /** Its project is kept off Kestrel Connect. */
  keptOff: boolean;
  /** Commits on the branch that no branch of `origin` has. */
  ahead: number;
}

export type NodePushSkip = 'not-a-node' | 'off' | 'not-its-branch' | 'base' | 'kept-off' | 'no-origin' | 'nothing';
export type NodePushStep = { push: true; branch: string; refspec: string } | { push: false; why: NodePushSkip };

/**
 * Whether to push, and what: `refs/heads/<branch>` to the same name on `origin`, never forced (the refspec has no
 * `+`). Never on a desktop, with the setting off, for a branch the session did not make (a guest works on its host's,
 * a review on somebody else's request, a sidebar is read-only), for the base branch, for a project kept off Kestrel
 * Connect or with no `origin`, or with nothing `origin` lacks.
 */
export function nodePushStep(f: NodePushFacts): NodePushStep {
  if (f.kind !== 'node') return { push: false, why: 'not-a-node' };
  if (!f.on) return { push: false, why: 'off' };
  const branch = f.session.branch;
  if (!branch || f.session.hostId || f.session.review || f.session.aside) return { push: false, why: 'not-its-branch' };
  if (f.base !== null && branch === f.base) return { push: false, why: 'base' };
  if (f.keptOff) return { push: false, why: 'kept-off' };
  if (!f.origin) return { push: false, why: 'no-origin' };
  if (f.ahead <= 0) return { push: false, why: 'nothing' };
  return { push: true, branch, refspec: `refs/heads/${branch}:refs/heads/${branch}` };
}

/** git's own line about a refused push: the rejected ref (`! [rejected] …`), else its `fatal:` or `error:` line, else its first. */
export function pushSaid(stderr: string): string {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => l.startsWith('!')) ?? lines.find((l) => l.startsWith('fatal:') || l.startsWith('error:')) ?? lines[0] ?? '';
}

/** The line in the session, and the notification's body, when the host refuses a push. */
export const pushFailedText = (branch: string, said: string): string => `Could not push \`${branch}\` to \`origin\`: ${said.trim() || 'git did not say why.'}`;
