// Pull and merge requests linked to a session, grouped in sidebar project order. The title opens
// the request in its first live session, and the status retains its merge or checks action.
import { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { WorkspaceState } from '@kestrel/server/model';
import { pullRequestStatus, type PullRequest } from '@kestrel/server/details';
import { hostTerms, requestNumber } from '@kestrel/server/host-terms';
import { arrange } from '@kestrel/server/sidebar';
import { countRequests, groupByProject, matchesRequestFilter, requestFilterChips, REQUEST_FILTER_EMPTY, type ListedRequest, type PullRequestList, type RequestFilter } from '@kestrel/server/pull-request-list';
import { pullRequestsView } from '@kestrel/server/routes';
import { InboxReference, InboxRowMenu, InboxSearch } from '../components/InboxList.tsx';
import { requestParts, useMergeConfirmation } from '../components/PullRequestParts.tsx';
import { contextMenu } from '../menuState.ts';
import { opener, openSession, openView, showLocal } from '../route.ts';
import { openPullRequest } from '../sessionView.ts';
import { useTabs } from '../tabsStore.ts';
import { PageHeader } from './PageHeader.tsx';
import { useWorkspaceRequests } from './useWorkspaceRequests.ts';

const NO_ORDER: readonly string[] = [];
const NO_PROJECT = 'No project';

/** Project ids in the sidebar's order: pinned ones first as PINNED lists them, then PROJECTS. */
function useSidebarProjectOrder(workspace: WorkspaceState): string[] {
  const order = useTabs((v) => v.sidebar.projectOrder ?? NO_ORDER);
  return useMemo(() => {
    const pinned = workspace.pins.filter((p) => p.kind === 'project').map((p) => p.id);
    const rest = arrange(workspace.projects.filter((p) => !pinned.includes(p.id)), (p) => p.id, order).map((p) => p.id);
    return [...pinned, ...rest];
  }, [workspace.pins, workspace.projects, order]);
}

const projectLabel = (workspace: WorkspaceState, id: string | null) => (id === null ? NO_PROJECT : (workspace.projects.find((p) => p.id === id)?.name ?? 'Project'));

/** One request: number, title, host link, status, and the sessions it is linked to. */
function RequestRow({ entry, onRefresh }: { entry: ListedRequest; onRefresh: () => void }) {
  // The first session still in sight is the one it opens in and merges through. A request whose
  // sessions are all archived (it stays listed for a week) opens on its host instead.
  const first = entry.sessions.find((s) => !s.archived);
  const terms = hostTerms(entry.host);
  const url = entry.pullRequest.url;
  const merge = useMergeConfirmation(first?.id, onRefresh);
  const onOpen = (pr: PullRequest) => {
    if (!first) return void window.open(pr.url, '_blank', 'noreferrer');
    openPullRequest(first.id, pr);
    openSession(first.id);
  };
  const parts = requestParts({ pr: entry.pullRequest, terms, onOpen, onMerge: entry.minimal ? undefined : merge.onMerge });
  const number = requestNumber(terms, entry.pullRequest.number);
  const title = entry.minimal ? `Could not load this ${terms.long}` : entry.pullRequest.title || `${terms.longTitle} ${number}`;
  const status = pullRequestStatus(entry.pullRequest);
  return (
    <li className="inbox-row prs-row">
      <button type="button" className="inbox-open" title={title} onClick={() => onOpen(entry.pullRequest)}>
        <span className={`inbox-title${entry.minimal ? ' prs-title-missing' : ''}`}>{title}</span>
        <span className="inbox-meta">
          <InboxReference service={terms.service}>{number}</InboxReference>
          {entry.pullRequest.author && <span>{entry.pullRequest.author}</span>}
        </span>
      </button>
      <span className={`prs-status pr-tone-${status.tone}`} title={entry.minimal ? 'The state it was last seen in' : undefined}>
        {parts.status}
      </span>
      {url && (
        <InboxRowMenu label={`Actions for ${number}`} onClick={(event) => {
          contextMenu.openFrom(event.currentTarget, [
            { id: 'open-link', label: `Open on ${terms.service}`, action: { type: 'open-link', url } },
            { id: 'copy-link', label: 'Copy link', action: { type: 'copy', text: url, what: 'Link' } },
          ], { returnFocus: event.currentTarget });
        }} />
      )}
      <span className="prs-sessions" aria-label={entry.sessions.length === 1 ? 'Session' : 'Sessions'}>
        {entry.sessions.map((s) =>
          s.archived ? (
            <button key={s.id} type="button" className="prs-session prs-session-archived" title={`“${s.title}” is archived. Restore it from Settings → Archived`} {...opener((newTab) => openView({ kind: 'settings', section: 'archived' }, newTab))}>
              {s.title} <span className="prs-session-note">archived</span>
            </button>
          ) : (
            <button key={s.id} type="button" className="prs-session" title={`Open the session “${s.title}”`} {...opener((newTab) => openSession(s.id, newTab))}>
              {s.title}
            </button>
          ),
        )}
      </span>
      {merge.confirmation}
    </li>
  );
}

function Chips({ list, filter }: { list: PullRequestList; filter: RequestFilter }) {
  const chips = requestFilterChips(countRequests(list.requests));
  return (
    <div className="chips inbox-tabs" role="group" aria-label="Pull request view">
      {chips.map((chip) => (
        <button key={chip.key} type="button" className={`chip${filter === chip.key ? ' selected' : ''}`} aria-pressed={filter === chip.key} onClick={() => showLocal(pullRequestsView(chip.key))}>
          {chip.label} <span className="chip-count">{chip.count}</span>
        </button>
      ))}
    </div>
  );
}

/** The projects whose host could not be asked, each with the reason: their requests show only what was stored. */
function Unasked({ list, workspace }: { list: PullRequestList; workspace: WorkspaceState }) {
  if (list.unasked.length === 0) return null;
  return (
    <ul className="prs-unasked" aria-label="Projects that could not be asked">
      {list.unasked.map((u) => (
        <li key={u.projectId ?? ''}>
          Could not ask about {projectLabel(workspace, u.projectId)}: {u.reason}. Its requests show what was last seen.
        </li>
      ))}
    </ul>
  );
}

function Groups({ groups, workspace, onRefresh }: { groups: ReturnType<typeof groupByProject>; workspace: WorkspaceState; onRefresh: () => void }) {
  return (
    <>
      {groups.map((group) => (
        <section key={group.projectId ?? ''} className="page-section">
          <h2>
            {projectLabel(workspace, group.projectId)} <span className="section-count">· {group.requests.length}</span>
          </h2>
          <ul className="inbox-list">
            {group.requests.map((entry) => (
              <RequestRow key={`${entry.host}:${entry.pullRequest.number}`} entry={entry} onRefresh={onRefresh} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function RequestsList({ list, filter, workspace, order, onRefresh }: { list: PullRequestList; filter: RequestFilter; workspace: WorkspaceState; order: readonly string[]; onRefresh: () => void }) {
  const [text, setText] = useState('');
  const [project, setProject] = useState('');
  const [descending, setDescending] = useState(true);
  const view = list.requests.filter((entry) => matchesRequestFilter(entry.pullRequest, filter));
  const projects = [...new Set(view.map((entry) => entry.projectId ?? NO_PROJECT))]
    .map((id) => ({ id, label: projectLabel(workspace, id === NO_PROJECT ? null : id) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const words = text.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const filtering = words.length > 0 || Boolean(project);
  const matches = view.filter(({ pullRequest: pr, host, projectId, sessions }) => {
    if (project && project !== (projectId ?? NO_PROJECT)) return false;
    const terms = hostTerms(host);
    const searchable = [pr.title, pr.author, requestNumber(terms, pr.number), terms.service, projectLabel(workspace, projectId), ...sessions.map((session) => session.title)].join(' ').toLowerCase();
    return words.every((word) => searchable.includes(word));
  });
  matches.sort((a, b) => (descending ? b.pullRequest.number - a.pullRequest.number : a.pullRequest.number - b.pullRequest.number));
  const groups = groupByProject(matches, filter, order);
  return (
    <>
      <div className="inbox-controls">
        <Chips list={list} filter={filter} />
        {(view.length > 0 || filtering) && (
          <div className="inbox-toolbar" role="group" aria-label="Filter and sort pull requests">
            <InboxSearch label="Search pull requests" value={text} onChange={setText} />
            {(projects.length > 1 || project) && (
              <select aria-label="Project" className={`form-control inbox-pick${project ? ' set' : ''}`} value={project} onChange={(event) => setProject(event.target.value)}>
                <option value="">Any project</option>
                {project && !projects.some(({ id }) => id === project) && (
                  <option value={project}>{projectLabel(workspace, project === NO_PROJECT ? null : project)}</option>
                )}
                {projects.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
              </select>
            )}
            {view.length > 1 && (
              <select aria-label="Sort pull requests" className="form-control inbox-pick set inbox-sort" value={descending ? 'highest' : 'lowest'} onChange={(event) => setDescending(event.target.value === 'highest')}>
                <option value="highest">Number · highest first</option>
                <option value="lowest">Number · lowest first</option>
              </select>
            )}
          </div>
        )}
        {filtering && (
          <div className="inbox-filter-summary">
            <span role="status">{matches.length} of {view.length} requests</span>
            <button type="button" className="link-button" onClick={() => { setText(''); setProject(''); }}>Clear filters</button>
          </div>
        )}
      </div>
      <Unasked list={list} workspace={workspace} />
      {list.requests.length === 0 ? (
        <div className="empty">
          <h2>No pull or merge requests are linked to a session yet</h2>
          <p>A request shows here once a session opens one, or one is found on a session’s branch. One whose session is archived stays for a week.</p>
        </div>
      ) : groups.length === 0 ? (
        <div className="empty">
          <h2>{view.length === 0 ? REQUEST_FILTER_EMPTY[filter] : 'No request matches these filters'}</h2>
        </div>
      ) : (
        <Groups groups={groups} workspace={workspace} onRefresh={onRefresh} />
      )}
    </>
  );
}

export function PullRequestsPage({ workspace, filter }: { workspace: WorkspaceState; filter: RequestFilter }) {
  // Asked again when a session's request state changes or the sessions in sight do.
  const refreshKey = useMemo(() => workspace.sessions.map((s) => `${s.id}:${s.request ?? ''}`).join(','), [workspace.sessions]);
  const { value, refreshing, refresh } = useWorkspaceRequests(refreshKey);
  const order = useSidebarProjectOrder(workspace);
  const busy = refreshing || value.state === 'loading';
  const refreshButton = (
    <button type="button" className="secondary-button small prs-refresh" onClick={refresh} disabled={busy} title="Ask the hosts again now">
      <RefreshCw aria-hidden className={busy ? 'prs-spinning' : undefined} /> Refresh
    </button>
  );
  return (
    <div className="page column inbox-page">
      <PageHeader title="Pull requests" line="Pull and merge requests linked to your sessions" actions={refreshButton} />
      {value.state === 'loading' && <p className="prs-note">Asking the hosts…</p>}
      {value.state === 'unavailable' && <p className="prs-note">Kestrel could not list the requests: {value.reason}</p>}
      {value.state === 'ready' && (
        <RequestsList list={value.value} filter={filter} workspace={workspace} order={order} onRefresh={refresh} />
      )}
    </div>
  );
}
