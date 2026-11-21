// Where each session is drawn in the sidebar before pins: its group, the Sessions list, or its
// project's list. Pure, shared with the UI through pinned-homes.ts. Every session has exactly one
// home (tags are additional and not decided here):
//   - a session in a group is drawn in that group's tree, delegates nested under the session that
//     delegated to them. Being in a group is the user's (or a split's) choice, so it wins over the
//     project the work is filed in; a session a task was handed off to joins that group too, as a
//     row of its own beside the one that handed it off (a handoff makes siblings, tree.ts);
//   - an ungrouped session with a project is drawn in that project's list when nothing above it is
//     drawn in the Sessions list. One a task was handed off to has nothing above it, so that is
//     where it goes: the handoff gave the work to a session of that project;
//   - an ungrouped delegated child stays nested under its parent in the Sessions list (it works for
//     that parent; the parent waits on it);
//   - anything else ungrouped (no project, or a hidden parent that handed off and changed nothing)
//     is drawn in the Sessions list. One whose parent went to a project list stands at the top of
//     the Sessions list with a "from" mark, as a session moved away from its parent does.
// A project's list holds one kind of nesting: a session that a row there delegated to, in that
// same project, is drawn under that row (it works for it, and both are listed in one place
// anyway). Whatever else hung under a session that went to a project's list finds its own home by
// the same rules.
import type { TreeNode } from '../model.ts';
import type { HomeSession } from './pinned-homes.ts';

export const UNGROUPED = 'ungrouped';

export interface SessionHomes {
  /** Trees per group id, plus `ungrouped`, holding only what is drawn there. */
  trees: Record<string, TreeNode[]>;
  /** Sessions drawn as rows of their project's list. */
  inProjectList: ReadonlySet<string>;
  /** What is drawn under a row of a project's list: the sessions it delegated to in that same project, and theirs. */
  nestedInProject: ReadonlyMap<string, TreeNode[]>;
}

/** A session that is drawn under no parent here: a top row, keeping its link as a "from" mark. */
const asTop = (node: TreeNode, parentId: string): TreeNode => ({ ...node, via: null, movedFrom: node.movedFrom ?? parentId });

/**
 * One level of the ungrouped tree. `top` says nothing above these rows stays in the Sessions list.
 * Returns the rows kept at this level, and the rows lifted to the top of the Sessions list.
 */
function place(nodes: readonly TreeNode[], top: boolean, at: Placing): { kept: TreeNode[]; lifted: TreeNode[] } {
  const kept: TreeNode[] = [];
  const lifted: TreeNode[] = [];
  let changed = false;
  for (const node of nodes) {
    if (at.projectOf(node.sessionId) && top) {
      at.inProjectList.add(node.sessionId);
      const nested = nestUnder(node, at, lifted);
      if (nested.length) at.nestedInProject.set(node.sessionId, nested);
      changed = true;
      continue;
    }
    const below = place(node.children, false, at);
    lifted.push(...below.lifted);
    const same = below.kept.length === node.children.length && below.kept.every((c, i) => c === node.children[i]);
    kept.push(same ? node : { ...node, children: below.kept });
    changed ||= !same;
  }
  return { kept: changed ? kept : (nodes as TreeNode[]), lifted };
}

interface Placing {
  projectOf: (id: string) => string | null;
  inProjectList: Set<string>;
  nestedInProject: Map<string, TreeNode[]>;
}

/**
 * What is drawn under `node` once it is a row of its project's list (or under such a row): its
 * delegates in that same project, each with its own. Everything else below it is placed by the
 * ordinary rules, and what stays in the Sessions list is added to `lifted` with a "from" mark.
 */
function nestUnder(node: TreeNode, at: Placing, lifted: TreeNode[]): TreeNode[] {
  const project = at.projectOf(node.sessionId);
  const here = (c: TreeNode) => c.via === 'delegate' && at.projectOf(c.sessionId) === project;
  const below = place(node.children.filter((c) => !here(c)), true, at);
  lifted.push(...below.kept.map((c) => asTop(c, node.sessionId)), ...below.lifted);
  return node.children.filter(here).map((c) => ({ ...c, children: nestUnder(c, at, lifted) }));
}

/** Where every session is drawn before pins. Untouched trees keep their identity. */
export function sessionHomes(trees: Readonly<Record<string, readonly TreeNode[]>>, sessions: readonly HomeSession[]): SessionHomes {
  const projectOf = new Map(sessions.map((s) => [s.id, s.filing.status === 'hidden' ? null : s.filing.projectId]));
  const at: Placing = { projectOf: (id) => projectOf.get(id) ?? null, inProjectList: new Set<string>(), nestedInProject: new Map<string, TreeNode[]>() };
  const out: Record<string, TreeNode[]> = {};
  for (const [key, tree] of Object.entries(trees)) {
    if (key !== UNGROUPED) {
      out[key] = tree as TreeNode[];
      continue;
    }
    const { kept, lifted } = place(tree, true, at);
    out[key] = lifted.length ? [...kept, ...lifted] : kept;
  }
  return { trees: out, inProjectList: at.inProjectList, nestedInProject: at.nestedInProject };
}
