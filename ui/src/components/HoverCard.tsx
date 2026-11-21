// The small card beside a sidebar row when the pointer rests on it (hoverCardState.ts says when): a
// project's (ProjectCard.tsx) or a session's (SessionCard.tsx). One at a time, beside the sidebar,
// level with the row and kept inside the window. It uses the context menu's surface, so it reads as
// the same family. Not shown on keyboard focus.
import { useEffect, useRef, type RefObject } from 'react';
import { isPinned } from '@kestrel/server/pins';
import { useContextMenu } from '../menuState.ts';
import { CARD_GAP, hoverCard, useHoverCard } from '../hoverCardState.ts';
import { useApp } from '../store.ts';
import { ProjectCardBody } from './ProjectCard.tsx';
import { SessionCardBody } from './SessionCard.tsx';
import { usePopupPlacement } from './usePopupPlacement.ts';

/** Close on Escape, a press outside the card, a scroll, the window losing focus, or any menu opening. */
function useClosers(box: RefObject<HTMLDivElement | null>) {
  const menu = useContextMenu();
  useEffect(() => void (menu && hoverCard.close()), [menu]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && hoverCard.close();
    const onPress = (e: Event) => !box.current?.contains(e.target as Node) && hoverCard.close();
    const onScroll = (e: Event) => !box.current?.contains(e.target as Node) && hoverCard.close();
    // Listened to in the capture phase, so an element losing focus (a press on a card button) also
    // passes here: only the window itself losing focus closes the card.
    const onBlur = (e: Event) => e.target === window && hoverCard.close();
    const dragOn = () => hoverCard.setDragging(true);
    const dragOff = () => hoverCard.setDragging(false);
    const pairs: [string, EventListener][] = [['keydown', onKey as EventListener], ['mousedown', onPress], ['scroll', onScroll], ['blur', onBlur], ['resize', hoverCard.close], ['dragstart', dragOn], ['dragend', dragOff], ['drop', dragOff]];
    pairs.forEach(([type, fn]) => window.addEventListener(type, fn, true));
    return () => pairs.forEach(([type, fn]) => window.removeEventListener(type, fn, true));
  }, [box]);
}

export function HoverCardHost() {
  const at = useHoverCard();
  const project = useApp((s) => (at?.kind === 'project' ? s.workspace?.projects.find((p) => p.id === at.id) : undefined));
  const pinned = useApp((s) => (at?.kind === 'project' ? isPinned(s.workspace?.pins ?? [], 'project', at.id) : false));
  const session = useApp((s) => (at?.kind === 'session' ? s.sessionsById.get(at.id) : undefined));
  const box = useRef<HTMLDivElement>(null);
  useClosers(box);
  usePopupPlacement(box, () => at && { anchor: at.anchor, side: 'right', align: 'start', gap: CARD_GAP }, [at, project, session]);
  if (!at || (!project && !session)) return null;
  return (
    <div
      ref={box}
      className={`context-menu hover-card ${project ? 'project-card' : 'session-card'}`}
      role="group"
      aria-label={project ? `${project.name}: project` : `${session!.title}: session`}
      onPointerEnter={hoverCard.enterCard}
      onPointerLeave={hoverCard.leave}
      onContextMenu={(event) => (event.preventDefault(), event.stopPropagation())}
    >
      {project ? <ProjectCardBody project={project} pinned={pinned} /> : <SessionCardBody session={session!} lineage={at.lineage ?? null} />}
    </div>
  );
}
