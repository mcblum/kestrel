// Projects a worker node does not have yet, cloned when a session starts in one (worker-nodes.md, section 9; item 64).
// Pure: which account projects a node offers to clone, how one is cloned (from `origin`, each repository of it), and
// every refusal's words, said here once for the node that refuses and for the device that reads it.
//
// Only a worker node clones on demand (`hostKind`): a desktop keeps its clones where the person keeps them, made by
// the person with their own credentials, and still says "Clone it there first" (account-sessions.md, 10.2).
import type { Project } from '../model.ts';
import type { KestrelKind } from './host-kind.ts';
import { repositoryShortName } from './account-projects.ts';
import { NODE_GIT_COMMAND } from './node-git.ts';
import { sizeText } from './node-host.ts';
import type { RemoteStartProject } from './machine-offers.ts';

/** Where a node keeps the projects it cloned: under Kestrel's own folder there (`~/.kestrel/projects`). */
export const CLONES_FOLDER = 'projects';
/** Below this much free disk where clones are kept, a clone is refused before it starts: a clone, its worktrees and the agents' caches need room. */
export const CLONE_DISK_MIN_BYTES = 2 * 1024 ** 3;
/** How long the git host is given to say whether the node's key may read a repository (`git ls-remote`). */
export const LS_REMOTE_TIMEOUT_MS = 20_000;
/** At most this many projects to clone are offered: the offers record stays small however large the account is. */
export const CLONE_OFFERS_MAX = 100;

/** One repository of a project to clone: its repository key, the folder it becomes, and the address it is cloned from. */
export interface CloneRepo {
  key: string;
  folder: string;
  url: string;
}

export interface ClonePlan {
  /** The project's name, as the computers that have it call it. */
  name: string;
  repos: CloneRepo[];
}

/** The repository's host: `github.com` of `github.com/acme/shop`. */
export const hostOfKey = (key: string): string => key.split('/')[0] ?? key;

/**
 * The address a repository is cloned from on a node: over ssh, with the node's own key (`kestrelGitEnv`). A repository
 * key keeps the host and the path and nothing else (no user, no port), so this is `git@<host>:<path>.git`.
 */
export function cloneUrlOf(key: string): string {
  const [host, ...path] = key.split('/');
  return `git@${host}:${path.join('/')}.git`;
}

/** "acme/shop", or "acme/shop and acme/api", as repositories are named in a sentence. */
const named = (keys: readonly string[]): string => {
  const short = keys.map((k) => `${repositoryShortName(k)}`);
  return short.length <= 1 ? (short[0] ?? '') : `${short.slice(0, -1).join(', ')} and ${short.at(-1)}`;
};

// ---- the words ------------------------------------------------------------------------------

/** The row's note while the node clones. */
export const cloningNote = (keys: readonly string[]): string => `Cloning ${named(keys)}…`;

/** A project whose folders are plain folders: nothing in git to clone. */
export const plainFolderRefusal = (project: string, other: string): string => `${project} is a folder on ${other}, not a repository: there is nothing to clone.`;

/** A repository with no `origin` there. */
export const noOriginRefusal = (project: string, other: string): string => `${project} has no \`origin\` on ${other}, so there is nothing to clone it from. Add one there and push it first.`;

/** An older computer's record says the repositories but not which folder each is. */
export const unmappedRefusal = (project: string, other: string): string => `${other} does not say which repository each folder of ${project} is. Update Kestrel there, then start the session again.`;

/** A base branch the starting device asked for that is not on `origin`. */
export const baseOnlyThereRefusal = (branch: string, other: string): string => `Push \`${branch}\` from ${other} first.`;

/** The node's key is not accepted by the git host for this repository. */
export const keyCannotReadRefusal = (node: string, key: string): string => `${node}'s key cannot read \`${repositoryShortName(key)}\`. Run \`${NODE_GIT_COMMAND}\` on ${node} to add it at ${hostOfKey(key)}.`;

/** The git host did not answer in time. */
export const hostSilentRefusal = (node: string, key: string): string => `${hostOfKey(key)} did not answer ${node} in ${LS_REMOTE_TIMEOUT_MS / 1000} seconds about \`${repositoryShortName(key)}\`. Try again in a moment.`;

/** No key of the node's own yet. */
export const noKeyRefusal = (node: string): string => `${node} has no git key of its own yet. Run \`${NODE_GIT_COMMAND}\` on ${node}, then start the session again.`;

/** Too little free disk where clones are kept. */
export const lowDiskRefusal = (node: string, freeBytes: number): string => `${node} has ${sizeText(freeBytes)} free, and a new clone wants at least ${sizeText(CLONE_DISK_MIN_BYTES)}. Free some space there first.`;

/** A project switched to "Keep off Kestrel Connect". */
export const keptOffRefusal = (project: string): string => `${project} is kept off Kestrel Connect, so it is not cloned on other computers.`;

/** The clone itself failed (git's own words follow): nothing of it is left behind. */
export const cloneFailedText = (key: string, why: string): string => `Could not clone \`${repositoryShortName(key)}\`: ${why.trim().replace(/[.\s]+$/, '') || 'git did not say why'}. Nothing of it was kept.`;

// ---- what is cloned and offered -------------------------------------------------------------------

/** The computer a project is named as being on, in a refusal: the first that has it. */
const otherOf = (project: Pick<Project, 'elsewhere'>): string => project.elsewhere?.machines[0]?.name ?? 'another computer';

/** A folder's name as a folder on disk: the record's name, kept to letters, digits, `.`, `_` and `-`. */
const folderWord = (name: string): string => name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '') || 'repository';

/**
 * How a project another computer has is cloned here, or why it cannot be: each git folder that names its `origin`
 * (`repo`) is cloned into a folder of that name; a git folder with no `origin` (`repo: null`) is left out. A record
 * from before folders named their repository (`repo` absent) is understood only when it has one git folder, and a
 * project known only from its sessions (no folders) by its first repository.
 */
export function clonePlanOf(project: Pick<Project, 'name' | 'elsewhere'>): { ok: true; plan: ClonePlan } | { ok: false; reason: string } {
  const where = project.elsewhere;
  const other = otherOf(project);
  if (!where) return { ok: false, reason: plainFolderRefusal(project.name, other) };
  if (where.folders.length === 0) {
    const first = where.repos[0];
    return first ? planOf(project.name, [{ name: repositoryShortName(first).split('/').at(-1) ?? project.name, repo: first }]) : { ok: false, reason: plainFolderRefusal(project.name, other) };
  }
  const git = where.folders.filter((f) => f.isGit);
  if (git.length === 0) return { ok: false, reason: plainFolderRefusal(project.name, other) };
  if (where.repos.length === 0) return { ok: false, reason: noOriginRefusal(project.name, other) };
  const old = git.every((f) => f.repo === undefined);
  if (old && git.length > 1) return { ok: false, reason: unmappedRefusal(project.name, other) };
  const folders = git.flatMap((f) => {
    const repo = old ? where.repos[0] : f.repo;
    return typeof repo === 'string' && repo.length > 0 ? [{ name: f.name, repo }] : [];
  });
  return folders.length > 0 ? planOf(project.name, folders) : { ok: false, reason: noOriginRefusal(project.name, other) };
}

function planOf(name: string, folders: readonly { name: string; repo: string }[]): { ok: true; plan: ClonePlan } {
  const used = new Set<string>();
  const repos = folders.flatMap((f) => {
    if (used.has(`key:${f.repo}`)) return [];
    used.add(`key:${f.repo}`);
    let folder = folderWord(f.name);
    for (let n = 2; used.has(folder); n++) folder = `${folderWord(f.name)}-${n}`;
    used.add(folder);
    return [{ key: f.repo, folder, url: cloneUrlOf(f.repo) }];
  });
  return { ok: true, plan: { name, repos } };
}

/** The project's ids on the computers that have it: what a device matches its own listing against. */
const idsOf = (project: Pick<Project, 'elsewhere'>): string[] => [...new Set((project.elsewhere?.machines ?? []).flatMap((m) => m.projectId ?? []))];

/** Whether a project listed here is kept off Kestrel Connect, by any of the ids it is known by. */
export const isKeptOff = (project: Pick<Project, 'id' | 'elsewhere'>, off: ReadonlySet<string>): boolean => off.has(project.id) || idsOf(project).some((id) => off.has(id));

/**
 * The account projects this node does not have and could clone, as a device picks them: by the id they have on the
 * first computer that has them, marked `clone` with their ids everywhere. Never a plain folder, a repository with no
 * `origin`, or a project kept off Kestrel Connect; at most `CLONE_OFFERS_MAX`.
 */
export function offeredClones(projects: readonly Project[], keptOff: readonly string[]): RemoteStartProject[] {
  const off = new Set(keptOff);
  return projects
    .filter((p) => p.away && !isKeptOff(p, off) && clonePlanOf(p).ok && idsOf(p).length > 0)
    .slice(0, CLONE_OFFERS_MAX)
    .map((p) => ({ id: idsOf(p)[0]!, name: p.name, folders: [], defaultFolderId: null, clone: { of: idsOf(p) } }));
}

/** The project a start names by one of its ids on another computer, when this computer does not have it. */
export function cloneTargetOf(projects: readonly Project[], projectId: string): Project | undefined {
  return projects.find((p) => p.away && idsOf(p).includes(projectId));
}

/** Why a project this node would clone is refused before anything starts, or null. Kept off first: it is never offered. */
export function cloneRefusal(project: Pick<Project, 'id' | 'name' | 'elsewhere'>, keptOff: readonly string[]): string | null {
  if (isKeptOff(project, new Set(keptOff))) return keptOffRefusal(project.name);
  const plan = clonePlanOf(project);
  return plan.ok ? null : plan.reason;
}

/** The base branch's refusal for a clone whose first repository's heads are `heads`, or null. */
export function baseRefusal(base: string | undefined, heads: readonly string[], project: Pick<Project, 'elsewhere'>): string | null {
  return base && !heads.includes(base) ? baseOnlyThereRefusal(base, otherOf(project)) : null;
}

/** The project's folder under the clones folder: its name in lower case, kept to letters, digits and `-`. */
export const projectFolderWord = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';

// ---- what a node's agents are told (worker-nodes.md section 9.3) ------------------------------------------------

/** The note of an account project a node has not cloned and could: a start in it clones it. */
export const CLONED_ON_START = 'It is cloned when a session starts in it.';

/** What `list_projects` and the standing instruction say of an account project this node has not cloned. */
export interface NotClonedRow {
  name: string;
  cloned: false;
  /** Its repositories, as every computer names them (`github.com/acme/shop`); empty for a plain folder. */
  repositories: string[];
  /** When it is cloned, or why it cannot be, in the refusal's own words. */
  note: string;
}

/**
 * The account projects a worker node has not cloned, for its agents: after the projects it has, each with
 * `cloned: false` and a note (being cloned, the reason it was not, the refusal it would get, else
 * `CLONED_ON_START`). Never a project kept off Kestrel Connect; by name; at most `CLONE_OFFERS_MAX`. A desktop
 * clones nothing by itself, so its agents are told nothing more (`kind`). `why`: the reason a clone was refused
 * or failed, by the project's id in the view; `cloning`: the ids being cloned now.
 */
export function notClonedRows(kind: KestrelKind, projects: readonly Project[], keptOff: readonly string[], why: ReadonlyMap<string, string>, cloning: ReadonlySet<string>): NotClonedRow[] {
  if (kind !== 'node') return [];
  const off = new Set(keptOff);
  return projects
    .filter((p) => p.away && !isKeptOff(p, off))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, CLONE_OFFERS_MAX)
    .map((p) => {
      const repositories = [...(p.elsewhere?.repos ?? [])];
      const note = cloning.has(p.id) ? cloningNote(repositories) : (why.get(p.id) ?? cloneRefusal(p, keptOff) ?? CLONED_ON_START);
      return { name: p.name, cloned: false as const, repositories, note };
    });
}
