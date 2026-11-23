import type { WorkspaceState } from '@kestrel/server/model';
import { STATUS_LABEL } from '@kestrel/server/status';
import { containerOf } from '@kestrel/server/routes';
import type { View } from '../route.ts';

/**
 * What a destination is called. The workspace tab, the page heading and the sidebar all use this.
 * A project has one name on all its local tabs (`containerOf`): never "Shrike · Settings".
 */
export function viewTitle(page: View, ws: (Pick<WorkspaceState, 'projects' | 'groups'> & Partial<Pick<WorkspaceState, 'workstreams' | 'archivedWorkstreams' | 'sessions'>>) | null): string {
  const view = containerOf(page);
  switch (view.kind) {
    case 'overview':
      return 'Overview';
    case 'attention':
      return STATUS_LABEL['needs-you'];
    case 'pull-requests':
      // A workspace can mix GitHub and GitLab projects: the page has the one name, each row its host's words.
      return 'Pull requests';
    case 'all':
      return 'All sessions';
    case 'unscoped':
      return 'Unscoped';
    case 'settings':
      return 'Settings';
    case 'move':
      return 'Move to project';
    case 'new-project':
      return 'Create project';
    case 'code': {
      // Several can be open at once: each says whose conversation its code is from.
      const from = ws?.sessions?.find((s) => s.id === view.sessionId)?.title;
      return from ? `Code · ${from}` : 'Code';
    }
    case 'project':
      return ws?.projects.find((p) => p.id === view.id)?.name ?? 'Project';
    case 'group':
      return ws?.groups.find((g) => g.id === view.id)?.name ?? 'Group';
    case 'tag':
      return view.id;
    case 'code-reviews':
      return 'Code reviews';
    case 'review-request':
      return 'Code review';
    case 'tickets':
      return 'Tickets';
    case 'ticket':
      return 'Ticket';
    case 'workstream':
      return (ws?.workstreams?.find((w) => w.id === view.id) ?? ws?.archivedWorkstreams?.find((w) => w.id === view.id))?.name ?? 'Workstream';
  }
}

/** `/Users/me/Code/x` as `~/Code/x`, for display only. */
export const homePath = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~');
