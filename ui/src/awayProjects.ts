// Projects another computer of the account has and this one does not (account-sessions.md, 10.2 and 10.3):
// listed in the sidebar and on their page, never offered where a folder here is needed (a picker, a setting
// about this computer's projects). The words come from one place, shared/account-projects.ts.
import type { Project } from '@kestrel/server/model';
import { notChangedHereRefusal, notHereMark, notHereRefusal, notHereText } from '@kestrel/server/account-projects';
import { thisComputer } from './platform.ts';
import { useApp } from './store.ts';

const NONE: readonly Project[] = [];
const kept = new WeakMap<readonly Project[], readonly Project[]>();

/** This computer's own projects among those listed: the same array while the list is unchanged. */
export function hereOnly(projects: readonly Project[] | undefined): readonly Project[] {
  if (!projects) return NONE;
  if (!projects.some((p) => p.away)) return projects;
  let here = kept.get(projects);
  if (!here) kept.set(projects, (here = projects.filter((p) => !p.away)));
  return here;
}

/** This computer's own projects, read from the store's one copy. */
export const useHereProjects = (): readonly Project[] => useApp((s) => hereOnly(s.workspace?.projects));

/** The project of that id when no folder of this computer is it, else null. */
export const awayProject = (projects: readonly Project[] | undefined, id: string | null | undefined): Project | null => (id ? (projects?.find((p) => p.id === id && p.away) ?? null) : null);

export const notHere = {
  /** "Not on this Mac", or "Only on Blum Laptop" for a plain folder. */
  mark: (project: Project): string => notHereMark(project, thisComputer()),
  /** The page's sentence: how to get it here, or where it runs. */
  text: (project: Project): string => notHereText(project, thisComputer()),
  /** Why New session in it is refused here. */
  refusal: (project: Project): string => notHereRefusal(project, thisComputer()),
  /** Why it has no folder to show here: "Billing is not on this Mac". */
  noFolder: (project: Project): string => (project.elsewhere?.repos.length ? `${project.name} is not on ${thisComputer()}` : `${project.name} is only on ${project.elsewhere?.machines[0]?.name ?? 'another computer'}`),
  /** Why renaming, archiving or setting it up is refused here. */
  unchanged: (project: Project): string => notChangedHereRefusal(project, thisComputer()),
};
