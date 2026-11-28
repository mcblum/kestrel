// A worker node mirrors the account's projects (worker-nodes.md section 9.3). Pure: which projects the mirror
// clones and in what order, when a mirrored clone is fetched again, and when a clone has left the account. The
// reconciler (project-clone/mirror.ts) derives everything from the account as the node's view has it, every
// time, and holds no list of its own; the clone, its checks and its words are 9.1's (shared/project-clone.ts).
import type { Project, SessionView } from '../model.ts';
import type { WorktreeWork } from './node-uninstall.ts';
import { clonePlanOf, isKeptOff } from './project-clone.ts';
import { moreRecent, recencyOf, recencyOfAll, type Recency, type Timed } from './session-order.ts';

/** At most this many clones run at once. */
export const MIRROR_CLONES_AT_ONCE = 2;
/** A mirrored clone is fetched again at most this often per project, when another computer's session in it changes. */
export const MIRROR_FETCH_MIN_MS = 5 * 60_000;

type Placed = Pick<SessionView, 'startedIn' | 'landedIn'>;

/** The project a session counts for: where it landed, else where it started. */
export const sessionProjectOf = (s: Placed): string | null => s.landedIn ?? s.startedIn;

/**
 * The account projects the mirror clones, in order: every one 9.1 would offer (not on this computer, not kept
 * off Kestrel Connect, with a repository to clone), the project with the most recent session first (`recencyOf`;
 * a working one ahead of all), then by name. `sessions`: the view's, this computer's and the others'.
 */
export function mirrorOrder(projects: readonly Project[], sessions: readonly (Placed & Pick<Timed, 'updatedAt' | 'lastActivityAt' | 'state'>)[], keptOff: readonly string[]): Project[] {
  const off = new Set(keptOff);
  const byProject = new Map<string, Recency[]>();
  for (const s of sessions) {
    const id = sessionProjectOf(s);
    if (id) byProject.set(id, [...(byProject.get(id) ?? []), recencyOf(s)]);
  }
  const recency = (p: Project): Recency => recencyOfAll(byProject.get(p.id) ?? []);
  return projects.filter((p) => p.away && !isKeptOff(p, off) && clonePlanOf(p).ok).sort((a, b) => moreRecent(recency(a), recency(b)) || a.name.localeCompare(b.name));
}

/** Whether a mirrored clone may be fetched now, last fetched at `last` (ms; undefined: never). */
export const fetchDue = (last: number | undefined, now: number): boolean => last === undefined || now - last >= MIRROR_FETCH_MIN_MS;

/**
 * Whether a clone the node made has left the account: no other computer has its repository any more (`alsoOn`
 * empty), or it is kept off Kestrel Connect here. Only then may it be deleted, and only with no work in it
 * (project-clone/mirror.ts).
 */
export const leavingClone = (project: Pick<Project, 'id' | 'alsoOn'>, keptOff: readonly string[]): boolean => (project.alsoOn?.length ?? 0) === 0 || keptOff.includes(project.id);

/**
 * Why a clone that left the account stays, or null when it may be deleted: a session of it running, then a worktree
 * with work not committed or not pushed (the counts `uninstall` takes), then any session still listed in it, since a
 * project goes only when no session is in it (`Workspace.removeProject`). `sessions`: every session of the project,
 * shown or archived.
 */
export function keptReason(sessions: readonly { title: string; running: boolean }[], work: readonly Pick<WorktreeWork, 'title' | 'uncommitted' | 'unpushed'>[]): string | null {
  if (sessions.length === 0) return null;
  const running = sessions.find((s) => s.running);
  if (running) return `"${running.title}" is running`;
  const unpushed = work.find((w) => w.unpushed > 0);
  if (unpushed) return `"${unpushed.title}" has work that is not pushed`;
  const uncommitted = work.find((w) => w.uncommitted > 0);
  if (uncommitted) return `"${uncommitted.title}" has work that is not committed`;
  return `${sessions.length} session${sessions.length === 1 ? ' is' : 's are'} still listed in it`;
}
