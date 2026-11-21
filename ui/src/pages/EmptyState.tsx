// Empty states, chosen by `emptyState()` in the shared status module. Each says what is true and
// offers the next move; none of them is "No sessions in this view".
import { CheckCheck, Plus } from 'lucide-react';
import type { EmptyKind } from '@kestrel/server/status';
import { opener } from '../route.ts';

interface Props {
  kind: EmptyKind;
  /** Project or folder name, for the messages that name it. */
  name?: string;
  /** `newTab` is a shift, Cmd or middle click. */
  onNewSession: (newTab: boolean) => void;
  onAddProject: () => void;
  onClearFilters: () => void;
}

export function EmptyState({ kind, name, onNewSession, onAddProject, onClearFilters }: Props) {
  // The first-session experience is the Overview's own; there is nothing generic to show.
  if (kind === 'first-session') return null;
  if (kind === 'attention')
    return (
      <div className="empty">
        <CheckCheck aria-hidden className="empty-icon" />
        <h2>Nothing needs you right now</h2>
        <p>Approvals, questions and failures from your sessions will queue up here.</p>
      </div>
    );
  if (kind === 'filtered')
    return (
      <div className="empty">
        <h2>No sessions match these filters</h2>
        <div className="empty-actions">
          <button className="secondary-button" onClick={onClearFilters}>
            Clear filters
          </button>
        </div>
      </div>
    );
  // A project or group page already has New session in its header: its empty state is two quiet
  // lines right under it, with no second button.
  if (kind === 'project' || kind === 'folder')
    return (
      <div className="empty-quiet">
        <p className="empty-quiet-title">No sessions yet</p>
        <p>{kind === 'project' ? `Start a session to work on ${name}.` : `Start a session in ${name}, or move sessions into it.`}</p>
      </div>
    );
  const text = { title: 'No sessions yet', action: 'Start a session' };
  return (
    <div className="empty">
      <h2>{text.title}</h2>
      <div className="empty-actions">
        <button className="primary-button" {...opener(onNewSession)}>
          <Plus aria-hidden /> {text.action}
        </button>
      </div>
    </div>
  );
}
