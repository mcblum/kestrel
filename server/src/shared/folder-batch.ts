// Adding several projects at once from one parent folder (docs/designs/kestrel.md, "Several projects
// from one folder"): what the server lists of a folder's subfolders, what a batch create answers, and
// the page's choices about them. Pure and browser-safe.
import type { Project } from '../model.ts';

/** Limits on listing a folder and on one batch create. Proposed defaults. */
export const PROJECT_BATCH_LIMITS = {
  /** Subfolders one listing shows, after sorting by name; the rest are counted, not listed. */
  maxListed: 500,
  /** Projects one batch create may make. */
  maxPerBatch: 100,
} as const;

/** One folder directly inside the folder that was listed. */
export interface ListedFolder {
  /** The entry's name in the parent (a symlink keeps its own name). */
  name: string;
  /** The real path, symlinks resolved: what a project would hold. */
  path: string;
  /** A git repository's top level. */
  isGit: boolean;
  /** False when Kestrel may not open it. */
  readable: boolean;
  /** The project that already has this folder, archived ones included. */
  project: { id: string; name: string } | null;
  /** Why it cannot become a project as it is (inside a repository, …), besides being registered or unreadable. */
  problem: string | null;
  /** The name a project made from it would get now (the unique-name rule); null when it cannot be added. */
  proposedName: string | null;
  /**
   * Set for a linked git worktree: the main checkout it belongs to, and the project that has that
   * checkout, if one does. The same repository again, on another branch; rarely a project of its own.
   */
  worktreeOf: { path: string; name: string; project: { id: string; name: string } | null } | null;
}

export interface FolderListing {
  /** The real path of the folder listed. */
  parent: string;
  folders: ListedFolder[];
  /** Subfolders found (hidden ones left out), listed or not. */
  total: number;
  /** True when `total` is more than were listed. */
  truncated: boolean;
}

/** What became of one folder in a batch create. */
export type BatchOutcome = { path: string; ok: true; project: Project } | { path: string; ok: false; error: string };

/** Whether a listed folder can be ticked. */
export const canAdd = (folder: ListedFolder): boolean => folder.readable && folder.project === null && folder.problem === null;

/**
 * Ticked when a listing arrives: the git repositories that are not projects yet. Plain folders and
 * linked worktrees (a second checkout of a repository already in the list) are left for the user.
 */
export const defaultSelection = (folders: readonly ListedFolder[]): string[] => folders.filter((f) => canAdd(f) && f.isGit && f.worktreeOf === null).map((f) => f.path);

/** What a linked worktree's row says: "Worktree of Bellbird", and the project that has the main checkout. Null for anything else. */
export function worktreeNote(folder: Pick<ListedFolder, 'worktreeOf'>): string | null {
  const main = folder.worktreeOf;
  if (!main) return null;
  return main.project ? `Worktree of ${main.name}, the project ${main.project.name}` : `Worktree of ${main.name}`;
}

/** Every folder that can be ticked ("All"). */
export const allSelectable = (folders: readonly ListedFolder[]): string[] => folders.filter(canAdd).map((f) => f.path);

/** `selected` with `path` ticked or unticked, in listing order. */
export function toggled(folders: readonly ListedFolder[], selected: readonly string[], path: string): string[] {
  const next = new Set(selected);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return folders.map((f) => f.path).filter((p) => next.has(p));
}

/** The primary button's words: how many will be added. */
export const addLabel = (count: number): string => (count === 0 ? 'Add projects' : `Add ${count} project${count === 1 ? '' : 's'}`);

/** The folders that failed, to leave ticked for another try. */
export const failedPaths = (outcomes: readonly BatchOutcome[]): string[] => outcomes.filter((o) => !o.ok).map((o) => o.path);

/** One line about a batch: what was added and what was not. */
export function batchSummary(outcomes: readonly BatchOutcome[]): string {
  const added = outcomes.filter((o) => o.ok).length;
  const failed = outcomes.length - added;
  const addedText = `Added ${added} project${added === 1 ? '' : 's'}.`;
  if (failed === 0) return addedText;
  const failedText = failed === 1 ? '1 folder was not added; the reason is under it.' : `${failed} folders were not added; the reason is under each.`;
  return added === 0 ? failedText.charAt(0).toUpperCase() + failedText.slice(1) : `${addedText} ${failedText}`;
}
