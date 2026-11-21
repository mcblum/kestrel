// Needs you: resolve decisions and blockers. Each row shows the real reason it is waiting.
import type { WorkspaceState } from '@kestrel/server/model';
import { FILTER_LABEL, inView, matchesFilter } from '@kestrel/server/status';
import { AttentionRow } from './AttentionRow.tsx';
import { EmptyState } from './EmptyState.tsx';
import { PageHeader } from './PageHeader.tsx';

export function NeedsYouPage({ workspace }: { workspace: WorkspaceState }) {
  const queue = workspace.sessions.filter((s) => inView(s, { kind: 'attention' }) && matchesFilter(s, 'needs-you')).sort((a, b) => a.updatedAt - b.updatedAt);
  return (
    <div className="page column">
      <PageHeader title={FILTER_LABEL['needs-you']} line={queue.length > 0 ? `${queue.length} waiting, longest first.` : undefined} />
      {queue.length === 0 ? (
        <EmptyState kind="attention" onNewSession={() => undefined} onAddProject={() => undefined} onClearFilters={() => undefined} />
      ) : (
        <div className="queue">
          {queue.map((s) => (
            <AttentionRow key={s.id} session={s} workspace={workspace} />
          ))}
        </div>
      )}
    </div>
  );
}
