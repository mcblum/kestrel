// Where the open session is drawn in the sidebar, so that a collapsed section, project or group
// that holds it can still show its row below the collapsed row (and the collapsed group row it is
// in). Pure, shared with the UI. Built on `sidebarHomes` (pinned-homes.ts), which decides where
// everything is drawn; this only reads that answer for one session.
import type { Group, TreeNode } from '../model.ts';
import type { HomeSession, SidebarHomes } from './pinned-homes.ts';

export type ActiveHome =
  /** Under PINNED: pinned itself, or inside a pinned session, group or project. */
  | { section: 'pinned' }
  /** Under CODE REVIEWS: a review session, or one hanging under it. */
  | { section: 'reviews' }
  /** In the Sessions list: loose (`groupId` null) or in a Sessions-list group. */
  | { section: 'sessions'; groupId: string | null }
  /** In a project's list: loose (`groupId` null) or in one of the project's groups. */
  | { section: 'projects'; projectId: string; groupId: string | null };

/** Whether session `id` is anywhere in the tree. */
export const treeContains = (nodes: readonly TreeNode[], id: string): boolean => nodes.some((n) => n.sessionId === id || treeContains(n.children, id));

const UNGROUPED = 'ungrouped';

/** Where session `id` is drawn, or null when none is open or it is not drawn (hidden, gone). */
export function activeHome(homes: SidebarHomes, groups: readonly Pick<Group, 'id' | 'projectId'>[], sessions: readonly HomeSession[], id: string | null): ActiveHome | null {
  if (!id) return null;
  if (homes.pinnedAway.has(id)) return { section: 'pinned' };
  if (homes.reviewAway.has(id)) return { section: 'reviews' };
  const groupId = Object.keys(homes.trees).find((key) => key !== UNGROUPED && treeContains(homes.trees[key]!, id));
  if (groupId) {
    const projectId = groups.find((g) => g.id === groupId)?.projectId ?? null;
    if (homes.pinnedGroups.has(groupId) || (projectId && homes.pinnedProjects.has(projectId))) return { section: 'pinned' };
    return projectId ? { section: 'projects', projectId, groupId } : { section: 'sessions', groupId };
  }
  if (treeContains(homes.trees[UNGROUPED] ?? [], id)) return { section: 'sessions', groupId: null };
  const nestedIn = [...homes.nestedInProject.values()].some((below) => treeContains(below, id));
  if (homes.inProjectList.has(id) || nestedIn) {
    const projectId = sessions.find((s) => s.id === id)?.filing.projectId ?? null;
    if (!projectId) return null;
    return homes.pinnedProjects.has(projectId) ? { section: 'pinned' } : { section: 'projects', projectId, groupId: null };
  }
  return null;
}
