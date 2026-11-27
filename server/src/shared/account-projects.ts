// Projects across the computers of one account (docs/designs/account-sessions.md, sections 5.2 and 10;
// Matt, 2026-11-25: "A project is added? On the server it goes. Other devices pull it."). Each computer
// writes one sealed record per project it has into the list `projects`; every other computer reads that
// list into its replica and lists the project, whether or not it has the files.
//
// A record carries what another computer needs to list the project and nothing private to a disk: its
// name, its repositories as every computer names them (repo-keys.ts), and for each folder its name,
// whether it is a git repository, and where it is under the home folder (`~/Code/wren`), never an
// absolute path. What another machine sends is read through `asProjectRecord` and nowhere else.
import type { Project } from '../model.ts';
import { folderName } from './project-folders.ts';
import type { Machine } from './machines.ts';
import { homePath } from './setup-record.ts';

/** The list every project record is in, before tagging. */
export const PROJECTS_LIST = 'projects';
/** What a project's record is filed under, before tagging: the writer's id for the project. */
export const projectLabel = (projectId: string): string => `project|${projectId}`;

const MAX_NAME = 200;
const MAX_REPOS = 20;
const MAX_FOLDERS = 40;

/** A folder of a project as another computer is told of it. */
export interface RecordFolder {
  name: string;
  isGit: boolean;
  /** Under the home folder as `~/…`; absent for a folder anywhere else. */
  path?: string;
}

/** One computer's project, as it holds it on the service. */
export interface AccountProject {
  /** The writer's id for the project. */
  id: string;
  /** The computer that has it. */
  machine: Machine;
  name: string;
  /** Its repository keys; empty for a plain folder or a repository with no `origin`. */
  repos: string[];
  folders: RecordFolder[];
}

/** What is sealed: the project, the computer that wrote it, and nothing else. */
export function projectRecordOf(project: Project, repos: readonly string[], machine: Machine, home: string): { v: 1; kind: 'project'; machine: Machine; project: Omit<AccountProject, 'machine'> } {
  const folders = project.folders.map((f): RecordFolder => {
    const path = homePath(f.path, home);
    return { name: folderName(f), isGit: f.isGit, ...(path.startsWith('~') ? { path } : {}) };
  });
  return { v: 1, kind: 'project', machine: { id: machine.id, name: machine.name }, project: { id: project.id, name: project.name, repos: [...repos], folders } };
}

const obj = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const text = (value: unknown, max = MAX_NAME): string | null => (typeof value === 'string' && value.length > 0 && value.length <= max ? value : null);

function asFolder(raw: unknown): RecordFolder | null {
  const r = obj(raw);
  const name = r && text(r.name);
  if (!r || !name) return null;
  const path = text(r.path, 1000);
  // Only a home-relative path is ever kept: anything else another computer sends is dropped.
  return { name, isGit: r.isGit === true, ...(path && path.startsWith('~') ? { path } : {}) };
}

/**
 * A project's record as opened, or null when it is not one. Which machine may write it, and which record
 * id it must be under, are the caller's to check.
 */
export function asProjectRecord(raw: unknown): AccountProject | null {
  const r = obj(raw);
  const machine = r && obj(r.machine);
  const machineId = machine && text(machine.id);
  const p = r && obj(r.project);
  const id = p && text(p.id);
  if (!r || r.kind !== 'project' || !machine || !machineId || !p || !id) return null;
  return {
    id,
    machine: { id: machineId, name: text(machine.name) ?? 'Another computer' },
    name: text(p.name) ?? 'Project',
    repos: Array.isArray(p.repos) ? [...new Set(p.repos.filter((k): k is string => typeof k === 'string' && k.length > 0 && k.length <= 300))].slice(0, MAX_REPOS) : [],
    folders: Array.isArray(p.folders) ? p.folders.slice(0, MAX_FOLDERS).flatMap((f) => asFolder(f) ?? []) : [],
  };
}

/**
 * The id a project another computer has, and this one does not, is listed under (account-view.ts): by its
 * repository, so every computer's clone is one project, or by its computer for a plain folder. No `:` in it,
 * as a page's panes are known by `project:<id>` (shared/scope.ts). A local project's id is a UUID, never these.
 */
export const awayIdOfRepo = (key: string): string => `account|${key}`;
export const awayIdOfFolder = (machineId: string, projectId: string): string => `machine|${machineId}|${projectId}`;
export const isAwayProjectId = (id: string): boolean => id.startsWith('account|') || id.startsWith('machine|');

/** The repository a project not on this computer is named by in the sentence that says how to get it: `matt/x` of `github.com/matt/x`. */
export function repositoryShortName(key: string): string {
  const parts = key.split('/').filter(Boolean);
  return parts.length > 2 ? parts.slice(1).join('/') : key;
}

/**
 * What a project's page says when no folder of this computer is the project (section 10.2): a repository
 * can be cloned here; a plain folder belongs to its computer (10.3).
 */
export function notHereText(project: Pick<Project, 'elsewhere'>, here: string): string {
  const where = project.elsewhere;
  if (!where) return '';
  const repo = where.repos[0];
  if (repo) return `To run sessions here, clone \`${repositoryShortName(repo)}\` on ${here}, or choose its folder if it is already here.`;
  return 'Sessions in it run there.';
}

/** What its page says instead when a folder of this computer is already the repository, only not yet a project in Kestrel. */
export const alreadyHereText = (shown: string, here: string): string => `\`${shown}\` on ${here} is this repository. Add it to run sessions here.`;

/** The quiet mark beside a project not on this computer: "Not on this Mac", or "Only on Blum Laptop" for a plain folder. */
export function notHereMark(project: Pick<Project, 'elsewhere'>, here: string): string {
  const where = project.elsewhere;
  if (!where) return '';
  if (where.repos.length > 0) return `Not on ${here}`;
  return `Only on ${where.machines[0]?.name ?? 'another computer'}`;
}

/** Why a session cannot be started in a project no folder of this computer is (issue 52 starts it there). */
export function notHereRefusal(project: Pick<Project, 'name' | 'elsewhere'>, here: string): string {
  const where = project.elsewhere;
  if (where && where.repos.length === 0) return `${project.name} is only on ${where.machines[0]?.name ?? 'another computer'}. ${notHereText(project, here)}`;
  // Plain text: a refusal is shown as it is, where the page draws the repository as code.
  return `${project.name} is not on ${here}. ${notHereText(project, here).replaceAll('`', '')}`.trim();
}

/** Why a project no folder of this computer is cannot be renamed, archived or set up from here. */
export function notChangedHereRefusal(project: Pick<Project, 'name' | 'elsewhere'>, here: string): string {
  const names = project.elsewhere?.machines.map((m) => m.name) ?? [];
  return `${project.name} is not on ${here}, so it can only be changed on ${names.join(' or ') || 'the computer that has it'}.`;
}
