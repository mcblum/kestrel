// Autopilot in the controls under the message box (docs/designs/pr-autopilot.md): drawn while the session
// has an open pull request, or Autopilot is already on for it. Text only (Matt, 2026-11-24: "leave off the
// autopilot icon and give it a gentle text color"), in the git colour while it is on, grey while off; its
// words say the state (`autopilotLabel`). A click on the words opens its menu: on or off, Merge when green,
// Watch the target branch's pipeline (named by the session's request's target branch).
import { useEffect, useRef, type MouseEvent } from 'react';
import { autopilotLabel, autopilotMenu, autopilotText, isWanted, offeredRequest } from '@kestrel/server/autopilot';
import { primaryPullRequest } from '@kestrel/server/details';
import { contextMenu, useContextMenu } from '../../menuState.ts';
import { opensUpward } from '../usePopupPlacement.ts';

/** Wide enough for every usual state on one line; a long reason reads in three or four. */
const AUTOPILOT_MENU_WIDTH = 300;
import { useApp } from '../../store.ts';

export function AutopilotControl({ sessionId }: { sessionId: string }) {
  const session = useApp((s) => s.sessionsById.get(sessionId));
  const hasRequest = useApp((s) => offeredRequest(s.pullRequests.get(sessionId)) !== null);
  // The target branch of the session's request, for the watch's words.
  const base = useApp((s) => {
    const lookup = s.pullRequests.get(sessionId);
    return lookup?.state === 'ready' ? (primaryPullRequest(lookup.value.pullRequests)?.baseBranch ?? null) : null;
  });
  const record = session?.autopilot;
  const on = isWanted(record);
  const button = useRef<HTMLButtonElement>(null);
  const open = useContextMenu();
  const ours = open !== null && open.returnFocus === button.current;
  // Its switches leave the menu open: as the server answers, the open menu shows the new state (and
  // Merge when green appears once Autopilot is on).
  useEffect(() => {
    if (ours) contextMenu.replace(autopilotMenu(sessionId, record, base));
  }, [ours, sessionId, record, base]);
  // A guest's request is its host's; a review session reviews somebody else's.
  if (!session || session.hostId || session.review || !(hasRequest || on)) return null;
  const press = (e: MouseEvent<HTMLButtonElement>) => {
    if (contextMenu.current()) return contextMenu.close();
    // One width in every state (Matt, 2026-11-24): a long stop reason wraps and the menu grows upward.
    contextMenu.openFrom(e.currentTarget, autopilotMenu(sessionId, record, base), { returnFocus: e.currentTarget, above: opensUpward(e.currentTarget), width: AUTOPILOT_MENU_WIDTH });
  };
  return (
    <span className="ctl ctl-autopilot">
      <button ref={button} type="button" className={`ctl-button${on ? ' ctl-autopilot-on' : ''}`} aria-haspopup="menu" title={`Autopilot: ${autopilotText(record)}`} onClick={press}>
        {autopilotLabel(record)}
      </button>
    </span>
  );
}
