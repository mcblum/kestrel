// The small "Invoice export · 2 sessions" chip a session in a workstream carries in Details (the header
// has the family chip, FamilyChip.tsx). A click opens the workstream's page; shift, Cmd or a middle click opens it in a new tab.
import { Waypoints } from 'lucide-react';
import { workstreamOf } from '@kestrel/server/workstreams';
import { workstreamColour } from '@kestrel/server/colours';
import { tintFor, useColours } from '../colours.ts';
import { opener, openView } from '../route.ts';
import { useApp } from '../store.ts';

const NONE: readonly never[] = [];

export function WorkstreamChip({ sessionId }: { sessionId: string }) {
  const workstream = useApp((s) => workstreamOf(s.workspace?.workstreams ?? NONE, sessionId));
  // The workstream's own colour, as a tag's chip takes its tag's.
  const colours = useColours();
  if (!workstream) return null;
  const tint = tintFor(workstreamColour(colours, workstream.id));
  const count = workstream.sessionIds.length;
  const sessions = `${count} session${count === 1 ? '' : 's'}`;
  return (
    <button type="button" className={`tag-chip workstream-chip${tint.className}`} style={tint.style} title={`Open the workstream ${workstream.name}`} {...opener((newTab) => openView({ kind: 'workstream', id: workstream.id }, newTab))}>
      <Waypoints aria-hidden />
      <span className="workstream-chip-name">{workstream.name}</span>
      <span className="workstream-chip-count">· {sessions}</span>
    </button>
  );
}

/** Whether a session is in a workstream, for a row that should not be drawn at all otherwise. */
export const useInWorkstream = (sessionId: string): boolean => useApp((s) => workstreamOf(s.workspace?.workstreams ?? NONE, sessionId) !== null);
