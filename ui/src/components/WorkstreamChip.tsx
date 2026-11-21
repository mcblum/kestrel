// The small "Invoice export · 2 sessions" chip a session in a workstream carries, in its top bar and
// in Details. A click opens the workstream's page; shift, Cmd or a middle click opens it in a new tab.
import { Waypoints } from 'lucide-react';
import { workstreamOf } from '@kestrel/server/workstreams';
import { opener, openView } from '../route.ts';
import { useApp } from '../store.ts';

const NONE: readonly never[] = [];

export function WorkstreamChip({ sessionId }: { sessionId: string }) {
  const workstream = useApp((s) => workstreamOf(s.workspace?.workstreams ?? NONE, sessionId));
  if (!workstream) return null;
  const count = workstream.sessionIds.length;
  const sessions = `${count} session${count === 1 ? '' : 's'}`;
  return (
    <button type="button" className="tag-chip workstream-chip" title={`Open the workstream ${workstream.name}`} {...opener((newTab) => openView({ kind: 'workstream', id: workstream.id }, newTab))}>
      <Waypoints aria-hidden />
      <span className="workstream-chip-name">{workstream.name}</span>
      <span className="workstream-chip-count">· {sessions}</span>
    </button>
  );
}

/** Whether a session is in a workstream, for a row that should not be drawn at all otherwise. */
export const useInWorkstream = (sessionId: string): boolean => useApp((s) => workstreamOf(s.workspace?.workstreams ?? NONE, sessionId) !== null);
