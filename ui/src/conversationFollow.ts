// How a conversation's page keeps to the end of it: one hook for a session here (SessionWorkspace.tsx) and one on
// another computer (RemoteSession.tsx), so the two cannot drift. The transcript is virtualized (MessageList.tsx):
// the list starts drawing at the end, and this keeps the scroll area there while the reader has not scrolled up.
//
// - The conversation runs the full height and the message box floats over its foot (`.composer-dock`); the box's
//   measured height is the room left under the last message.
// - Following: true while the reader is at the bottom; scrolling up lets go, coming back to the bottom (or sending a
//   message, `toBottom`) takes hold again. Anything that makes the conversation taller keeps the bottom in view.
// - Where a session was left when the reader had scrolled up is restored when it comes back. View state only.
import { useEffect, useRef, useState, type RefObject, type UIEvent } from 'react';

/** Within a few pixels of the end counts as the bottom. */
const isAtBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 48;
/** What the box is taken to measure before it has been measured. */
const COMPOSER_GUESS_PX = 140;

/** Where a session was left when the reader had scrolled up. A session left at the bottom has no entry and opens at the bottom, however much it has grown since. */
const scrollMemory = new Map<string, number>();

export interface FollowEnd {
  /** The conversation's scroll area. */
  bodyRef: RefObject<HTMLDivElement | null>;
  /** The scroll area's content, watched for growth. */
  setInner: (el: HTMLDivElement | null) => void;
  /** The message box's dock, measured. */
  setDock: (el: HTMLDivElement | null) => void;
  composerHeight: number;
  isFollowing: () => boolean;
  /** The reader has scrolled up: the page offers a way back down. */
  away: boolean;
  toBottom: () => void;
  onScroll: (e: UIEvent<HTMLDivElement>) => void;
  /** Where the list starts: where the session was left, or (undefined) at the end. */
  initialTop: number | undefined;
}

/**
 * `count`: how many messages are drawn (the first time there are any, the place is restored). `land`: asked then
 * whether the page jumped somewhere of its own (a card waiting, a message linked to); if so it does not follow.
 */
export function useFollowEnd(id: string, count: number, land?: () => boolean): FollowEnd {
  const bodyRef = useRef<HTMLDivElement>(null);
  // Held in state, not refs: they are not on the page until the session has loaded, and the effects that watch
  // them have to run again when they appear.
  const [inner, setInner] = useState<HTMLDivElement | null>(null);
  const [dock, setDock] = useState<HTMLDivElement | null>(null);
  const [composerHeight, setComposerHeight] = useState(COMPOSER_GUESS_PX);
  useEffect(() => {
    if (!dock) return;
    const observer = new ResizeObserver(() => setComposerHeight(Math.round(dock.getBoundingClientRect().height)));
    observer.observe(dock);
    return () => observer.disconnect();
  }, [dock]);
  const follow = useRef(true);
  const [isFollowing] = useState(() => () => follow.current);
  // The last scroll position seen, to tell the reader scrolling up from the page growing under them.
  const lastTop = useRef(0);
  const [away, setAway] = useState(false);
  // The session whose place was last restored: the page can show another session without remounting.
  const restored = useRef<string | null>(null);
  const landing = useRef(land);
  landing.current = land;

  const toBottom = () => {
    const el = bodyRef.current;
    if (!el) return;
    follow.current = true;
    setAway(false);
    el.scrollTop = el.scrollHeight;
  };
  // Come back to where this session was left the first time there is something to show.
  useEffect(() => {
    if (!bodyRef.current || count === 0 || restored.current === id) return;
    restored.current = id;
    const landed = landing.current?.() ?? false;
    const top = scrollMemory.get(id);
    // On the way to the end every step is downwards, so none of them reads as the reader scrolling up.
    lastTop.current = top ?? 0;
    follow.current = !landed && top === undefined;
    setAway(!follow.current);
  }, [count, id]);
  // Anything that makes the conversation taller (a message, streamed text, a tool step, the status line) keeps
  // the bottom in view, unless the reader has scrolled up.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !inner) return;
    const observer = new ResizeObserver(() => {
      if (follow.current) el.scrollTop = el.scrollHeight;
    });
    // Border box, so the room left under the last message (padding) counts as growth too.
    observer.observe(inner, { box: 'border-box' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [inner]);

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    // Only the reader moving up lets go of the bottom. A scroll event that arrives after the page grew (a picture
    // loaded, the message box was measured) finds the view short of the new end without anyone having scrolled;
    // the height observer brings it back down.
    if (isAtBottom(el)) follow.current = true;
    else if (el.scrollTop < lastTop.current - 1) follow.current = false;
    lastTop.current = el.scrollTop;
    if (follow.current) scrollMemory.delete(id);
    else scrollMemory.set(id, el.scrollTop);
    setAway(!follow.current);
  };

  return { bodyRef, setInner, setDock, composerHeight, isFollowing, away, toBottom, onScroll, initialTop: scrollMemory.get(id) };
}
