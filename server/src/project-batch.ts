// Several projects at once, one per folder (shared/folder-batch.ts). Each folder gets exactly what a
// single add gives it: the same checks (project-store.ts), a name after the folder made unique
// (`uniqueProjectName`), and the same insert (`insertNewProject`). Each succeeds or fails on its own
// with its own reason; a failure undoes nothing. The disk and git checks run first, outside the
// store's transaction; then one transaction checks against the projects (including those made earlier
// in the batch) and inserts, so the workspace changes, and is broadcast, once for the whole batch.
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { isReadable, unreadableReason } from './folder-listing.ts';
import type { Project, ProjectFolder } from './model.ts';
import type { Persistence } from './persistence/types.ts';
import { checkName, existingFolder, gitChecked, insertNewProject, refuseHeld } from './project-store.ts';
import { Refused } from './refused.ts';
import { uniqueProjectName } from './runtime/projects.ts';
import { PROJECT_BATCH_LIMITS, type BatchOutcome } from './shared/folder-batch.ts';
import type { Workspace } from './workspace.ts';

/** A folder after the disk checks: ready to check against the projects, or already refused. */
type OnDisk = { given: string; folder: Omit<ProjectFolder, 'id'> } | { given: string; error: string };

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The checks a single add makes on disk, plus that Kestrel may open the folder. */
async function onDisk(given: string): Promise<OnDisk> {
  try {
    const dir = existingFolder(given);
    if (!isReadable(dir)) return { given, error: unreadableReason(dir) };
    return { given, folder: await gitChecked(dir, given) };
  } catch (error) {
    if (error instanceof Refused) return { given, error: reason(error) };
    throw error;
  }
}

/** One folder made into a project inside the batch's transaction, checked against `projects`: every project so far. */
async function addOne(tx: Persistence, checked: OnDisk, projects: readonly Project[]): Promise<BatchOutcome> {
  if ('error' in checked) return { path: checked.given, ok: false, error: checked.error };
  const { folder } = checked;
  try {
    refuseHeld(folder.path, checked.given, projects);
    const name = checkName(uniqueProjectName(basename(folder.path), folder.path, projects), projects);
    const project = await insertNewProject(tx, name, [{ id: randomUUID(), ...folder }]);
    return { path: checked.given, ok: true, project };
  } catch (error) {
    if (error instanceof Refused) return { path: checked.given, ok: false, error: reason(error) };
    throw error;
  }
}

/** A refusal for a batch that is empty or larger than the limit. */
function checkSize(count: number): void {
  if (count === 0) throw new Refused('Choose at least one folder to add.');
  const max = PROJECT_BATCH_LIMITS.maxPerBatch;
  if (count > max) throw new Refused(`At most ${max} projects can be added at once; ${count} were chosen. Add them in smaller batches.`);
}

/** A project for each folder, in the order given; what became of each. */
export async function createProjects(workspace: Workspace, folders: readonly string[]): Promise<BatchOutcome[]> {
  checkSize(folders.length);
  const checked: OnDisk[] = [];
  for (const given of folders) checked.push(await onDisk(given));
  return workspace.changeProjects(async (tx) => {
    // Read once; each project made joins the list the next folder is checked against.
    let projects = await tx.listProjects();
    const outcomes: BatchOutcome[] = [];
    for (const item of checked) {
      const outcome = await addOne(tx, item, projects);
      if (outcome.ok) projects = [...projects, outcome.project];
      outcomes.push(outcome);
    }
    return outcomes;
  });
}
