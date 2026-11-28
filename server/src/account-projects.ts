// This computer's copy of the projects the account's other computers have (docs/designs/account-sessions.md,
// sections 5.2 and 10): local data behind `Persistence`, kept as account records of their own, written only
// by the project sync (connect/link/project-sync.ts) and read by `Workspace.view()`. A batch is one
// transaction and one `changed()`, and only when something differs.
//
// Nothing here is a project of this computer: these rows are never in `projects`, so nothing that runs,
// files or counts ever sees them.
import type { Persistence } from './persistence/types.ts';
import type { AccountProject } from './shared/account-projects.ts';

const PROJECT = 'aproject|';
const FEED = 'feed|projects';

/** A project another computer holds, under the (tagged) record id it was read from. */
export interface HeldProject {
  record: string;
  project: AccountProject;
}

/** Where the reading of the projects feed stands, as `FeedMark` does for heads. */
export interface ProjectFeedMark {
  seq: number;
  at: number;
  scope: string;
  members: string[];
}

export interface ProjectBatch {
  projects: readonly HeldProject[];
  /** Record ids the feed says were deleted. */
  gone: readonly string[];
  /** The account's other computers now: any other computer's projects are dropped. */
  members: readonly string[];
  /** The projects given are every one there is. */
  whole: boolean;
  mark: ProjectFeedMark | null;
}

function parsed<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/** The projects among the replica's records. */
export function heldProjects(records: readonly { key: string; value: string }[]): HeldProject[] {
  return records.filter((r) => r.key.startsWith(PROJECT)).flatMap((r) => parsed<HeldProject>(r.value) ?? []);
}

export class AccountProjects {
  private readonly readers = new Set<() => void>();

  constructor(
    private readonly db: Persistence,
    private readonly changed: () => void,
  ) {}

  /** Told after each reading of the projects feed is stored, changed or not: when the link comes up, the service says `changed`, or the devices change (a worker node's mirror, project-clone/mirror.ts). Returns the undo. */
  onRead(listener: () => void): () => void {
    this.readers.add(listener);
    return () => void this.readers.delete(listener);
  }

  async list(): Promise<HeldProject[]> {
    return heldProjects(await this.db.listAccountRecords());
  }

  async feedMark(): Promise<ProjectFeedMark | null> {
    const record = (await this.db.listAccountRecords()).find((r) => r.key === FEED);
    return record ? parsed<ProjectFeedMark>(record.value) : null;
  }

  /**
   * Takes one reading of the projects feed. A record belongs to the computer that first wrote it: another
   * never takes it over. A computer not in `members` (removed from the account) loses every project it
   * had; another computer's record of the same repository is its own and stays. Answers whether anything
   * the window draws differs.
   */
  async apply(batch: ProjectBatch): Promise<boolean> {
    const differs = await this.db.transaction(async (tx) => {
      const before = new Map(heldProjects(await tx.listAccountRecords()).map((h) => [h.record, h]));
      const keep = new Set(batch.members);
      const given = new Set<string>();
      let any = false;
      for (const held of batch.projects) {
        if (!keep.has(held.project.machine.id)) continue;
        const was = before.get(held.record);
        if (was && was.project.machine.id !== held.project.machine.id) continue;
        given.add(held.record);
        if (was && JSON.stringify(was) === JSON.stringify(held)) continue;
        await tx.putAccountRecord(PROJECT + held.record, JSON.stringify(held));
        any = true;
      }
      const gone = new Set(batch.gone.filter((id) => before.has(id) && !given.has(id)));
      for (const was of before.values()) if (!keep.has(was.project.machine.id) || (batch.whole && !given.has(was.record))) gone.add(was.record);
      for (const id of gone) await tx.deleteAccountRecord(PROJECT + id);
      if (batch.mark) await tx.putAccountRecord(FEED, JSON.stringify(batch.mark));
      return any || gone.size > 0;
    });
    if (differs) this.changed();
    if (batch.mark) for (const listener of this.readers) listener();
    return differs;
  }

  /** Signed out: nothing of the account stays. */
  async clear(): Promise<void> {
    await this.apply({ projects: [], gone: [], members: [], whole: true, mark: null });
    await this.db.deleteAccountRecord(FEED);
  }
}
