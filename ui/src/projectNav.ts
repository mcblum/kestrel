// Getting to the project pages: the Create project page (and back again on Cancel), and a project's
// Settings tab (the folder count under its title, "Add folder…" and "Agent setup…" in its menu and
// hover card, "Add a folder" in an empty pane).
import { OVERVIEW_PATH } from '@kestrel/server/tabs';
import { containerOf, projectSettings, type ProjectSection, type ProjectView } from '@kestrel/server/routes';
import { currentRoute, openView, showLocal } from './route.ts';
import { activeTab, tabActions, tabsView } from './tabsStore.ts';

/** The page the user was on when they opened Create project, for Cancel. */
let returnPath: string | null = null;

/**
 * Open the Create project page, remembering the page in front to come back to. `fromFolder` opens
 * it on its second way in: several projects from one parent folder.
 */
export function openCreateProject(newTab = false, fromFolder = false): void {
  const tab = activeTab(tabsView());
  returnPath = !newTab && tab.kind === 'page' ? tab.path : null;
  openView(fromFolder ? { kind: 'new-project', from: 'folder' } : { kind: 'new-project' }, newTab);
}

/** Back to where Create project was opened from (Overview when that was not a page). */
export function leaveCreateProject(): void {
  tabActions.open({ kind: 'page', path: returnPath ?? OVERVIEW_PATH });
  returnPath = null;
}

/** After several projects were added: the Overview, where they show (one project opens its own page instead). */
export function leaveToOverview(): void {
  tabActions.open({ kind: 'page', path: OVERVIEW_PATH });
  returnPath = null;
}

/** Show `view` of a project: in place when that project's page is in front, else like any page. */
function openProjectView(view: ProjectView, newTab: boolean): void {
  const here = containerOf(currentRoute().view);
  if (!newTab && activeTab(tabsView()).kind === 'page' && here.kind === 'project' && here.id === view.id) showLocal(view);
  else openView(view, newTab);
}

/** Show a project's Sessions tab ("Open project page"). */
export const openProjectPage = (projectId: string, newTab = false) => openProjectView({ kind: 'project', id: projectId }, newTab);

/** Show a project's Settings tab, at `section`: switching the local tab when that project is in front. */
export const openProjectSettings = (projectId: string, section?: ProjectSection, newTab = false) => openProjectView(projectSettings(projectId, section), newTab);

/** Settings → Folders of a project. */
export const openProjectFolders = (projectId: string, newTab = false) => openProjectSettings(projectId, 'folders', newTab);
