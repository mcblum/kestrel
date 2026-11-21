// A project as stored, from what a caller hands the workspace: its directories, or (older callers,
// the sample data) one `path`, which becomes a single directory under the project's own id.
import { randomUUID } from 'node:crypto';
import type { Project, ProjectFolder } from './model.ts';

export interface NewProject {
  id?: string;
  name: string;
  folders?: { id?: string; path: string; isGit: boolean }[];
  path?: string;
  isGit?: boolean;
}

export function projectRecord(p: NewProject): Project {
  const id = p.id ?? randomUUID();
  const given = p.folders ?? (p.path ? [{ id, path: p.path, isGit: p.isGit === true }] : []);
  const folders: ProjectFolder[] = given.map((f) => ({ id: f.id ?? randomUUID(), path: f.path, isGit: f.isGit }));
  return { id, name: p.name, folders };
}

/** Another project already called `name`, in any case; undefined when the name is free. */
export const nameTakenBy = (projects: readonly Project[], name: string, except?: string): Project | undefined => projects.find((p) => p.id !== except && p.name.toLowerCase() === name.toLowerCase());
