// Resolving where an agent names: a project by registered name (any case) or by the path of one of
// its directories, then one of its directories by name or path (the default when none is named).
// An unknown or ambiguous name returns an error that lists the valid choices, so the agent can retry.
import { resolve } from 'node:path';
import type { Project, ProjectFolder } from '../model.ts';
import { defaultFolder, folderName } from './project-folders.ts';

export type Match<P extends Project> = { project: P; folder: ProjectFolder | null } | { error: string };

const pathsText = (p: Project) => (p.folders.length ? p.folders.map((f) => f.path).join(', ') : 'no directory yet');
export const listProjectsText = (projects: readonly Project[]) => (projects.length ? projects.map((p) => `${p.name} (${pathsText(p)})`).join('; ') : 'none are registered');

const samePath = (f: ProjectFolder, wanted: string) => f.path === wanted || f.path === resolve(wanted);

/** One of the project's directories by name (any case) or path; its default when `given` is empty. */
export function matchFolder(project: Project, given: string | undefined): { folder: ProjectFolder | null } | { error: string } {
  const wanted = (given ?? '').trim();
  if (!wanted) return { folder: defaultFolder(project) };
  const byPath = project.folders.find((f) => samePath(f, wanted));
  if (byPath) return { folder: byPath };
  const byName = project.folders.filter((f) => folderName(f).toLowerCase() === wanted.toLowerCase());
  if (byName.length === 1) return { folder: byName[0]! };
  if (byName.length > 1) return { error: `"${wanted}" matches more than one directory of ${project.name}. Use its full path: ${byName.map((f) => f.path).join('; ')}.` };
  const choices = project.folders.length ? project.folders.map((f) => `${folderName(f)} (${f.path})`).join('; ') : 'it has none yet';
  return { error: `${project.name} has no directory "${wanted}". Its directories: ${choices}.` };
}

/** A project by name or by one of its directories' paths (which also chooses that directory unless `folder` names one). */
export function matchProject<P extends Project>(given: string, projects: readonly P[], folder?: string): Match<P> {
  const wanted = given.trim();
  if (!wanted) return { error: `A project is required. Valid projects: ${listProjectsText(projects)}.` };
  const atPath = projects.find((p) => p.folders.some((f) => samePath(f, wanted)));
  if (atPath && !folder?.trim()) return { project: atPath, folder: atPath.folders.find((f) => samePath(f, wanted)) ?? null };
  const byName = atPath ? [atPath] : projects.filter((p) => p.name.toLowerCase() === wanted.toLowerCase());
  if (byName.length > 1) return { error: `"${wanted}" matches more than one project. Use the path of one of its directories: ${byName.map(pathsText).join('; ')}.` };
  const project = byName[0];
  if (!project) return { error: `No registered project "${wanted}". Valid projects: ${listProjectsText(projects)}.` };
  const chosen = matchFolder(project, folder);
  return 'error' in chosen ? chosen : { project, folder: chosen.folder };
}
