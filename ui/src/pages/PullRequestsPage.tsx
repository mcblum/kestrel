// Pull requests: every pull or merge request linked to a session in sight (or to one archived in
// the last week, which is named as archived), once each, grouped by
// project in the sidebar's order (shared/pull-request-list.ts). Filter chips with counts (the chosen
// one is kept in the tab's path), a Refresh button, and per row the same separate targets as every
// other request: the number opens its tab inside its first session, the icon opens the host, the
// status part merges (the usual confirmation) or opens the checks, and each linked session opens.
import { useMemo } from 'react';
import { RefreshCw } from 'lucide-react';
import type { WorkspaceState } from '@kestrel/server/model';
import { pullRequestStatus, type PullRequest } from '@kestrel/server/details';
import { hostTerms } from '@kestrel/server/host-terms';
import { arrange } from '@kestrel/server/sidebar';
import { countRequests, groupByProject, requestFilterChips, REQUEST_FILTER_EMPTY, type ListedRequest, type PullRequestList, type RequestFilter } from '@kestrel/server/pull-request-list';
import { pullRequestsView } from '@kestrel/server/routes';
import { requestParts, useMergeConfirmation } from '../components/PullRequestParts.tsx';
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
  const merge = useMergeConfirmation(first?.id, onRefresh);
  const onOpen = (pr: PullRequest) => {
    if (!first) return void window.open(pr.url, '_blank', 'noreferrer');
    openPullRequest(first.id, pr);
    openSession(first.id);
  };
  const parts = requestParts({ pr: entry.pullRequest, terms, onOpen, onMerge: entry.minimal ? undefined : merge.onMerge });
  const title = entry.minimal ? `Not loaded: ${terms.service} could not be asked` : entry.pullRequest.title;
  const status = pullRequestStatus(entry.pullRequest);
  return (
    <li className="prs-row">
      <span className="prs-number">{parts.number}</span>
      <span className={`prs-title${entry.minimal ? ' prs-title-missing' : ''}`} title={title}>
        {title}
      </span>
      <span className="prs-external">{parts.external}</span>
      <span className={`prs-status pr-tone-${status.tone}`} title={entry.minimal ? 'The state it was last seen in' : undefined}>
        {parts.status}
      </span>
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
    <div className="filter-row">
      <div className="chips" role="group" aria-label="Filter requests">
        {chips.map((chip) => (
          <button key={chip.key} className={`chip${filter === chip.key ? ' selected' : ''}`} aria-pressed={filter === chip.key} onClick={() => showLocal(pullRequestsView(chip.key))}>
            {chip.label} <span className="chip-count">{chip.count}</span>
          </button>
        ))}
      </div>
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

function Groups({ list, filter, workspace, order, onRefresh }: { list: PullRequestList; filter: RequestFilter; workspace: WorkspaceState; order: readonly string[]; onRefresh: () => void }) {
  const groups = groupByProject(list.requests, filter, order);
  if (list.requests.length === 0)
    return (
      <div className="empty">
        <h2>No pull or merge requests are linked to a session yet</h2>
        <p>A request shows here once a session opens one, or one is found on a session’s branch. One whose session is archived stays for a week.</p>
      </div>
    );
  if (groups.length === 0)
    return (
      <div className="empty">
        <h2>{REQUEST_FILTER_EMPTY[filter]}</h2>
      </div>
    );
  return (
    <>
      {groups.map((group) => (
        <section key={group.projectId ?? ''} className="page-section prs-project">
          <h2>
            {projectLabel(workspace, group.projectId)} <span className="section-count">· {group.requests.length}</span>
          </h2>
          <ul className="prs-list">
            {group.requests.map((entry) => (
              <RequestRow key={`${entry.host}:${entry.pullRequest.number}`} entry={entry} onRefresh={onRefresh} />
            ))}
          </ul>
        </section>
      ))}
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
    <div className="page column prs-page">
      <PageHeader title="Pull requests" line="Every pull and merge request linked to a session, by project." actions={refreshButton} />
      {value.state === 'loading' && <p className="prs-note">Asking the hosts…</p>}
      {value.state === 'unavailable' && <p className="prs-note">Kestrel could not list the requests: {value.reason}</p>}
      {value.state === 'ready' && (
        <>
          <Chips list={value.value} filter={filter} />
          <Unasked list={value.value} workspace={workspace} />
          <Groups list={value.value} filter={filter} workspace={workspace} order={order} onRefresh={refresh} />
        </>
      )}
    </div>
  );
}
