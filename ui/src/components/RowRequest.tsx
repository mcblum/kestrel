// The pull/merge request icon in the corner of a rail button when it has no dot and the session has
// an open, draft or merged request (shared/row-slot.ts decides). The rail keeps one corner, so it
// shows the request alone; a sidebar row draws its changed-files icon too (RowIcons.tsx). Not a
// button: the whole rail button stays the click target. Drawn only when asked (asksForRequest).
import { requestIcon } from '@kestrel/server/row-slot';
import { usePullRequests } from './details/sources.ts';
import { SlotIcon } from './RowIcons.tsx';

export function RowRequest({ sessionId, updatedAt, className }: { sessionId: string; updatedAt: number; className: string }) {
  const source = usePullRequests(sessionId);
  const icon = requestIcon(source.value);
  return icon ? <SlotIcon kind="request" icon={icon} className={className} /> : null;
}
