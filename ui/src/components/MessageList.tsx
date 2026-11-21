// The conversation's messages in order, as rows (@kestrel/server/conversation-rows). A stretch where
// the agent worked on its own is drawn folded where it began (@kestrel/server/conversation-folds).
//
// Only the rows near the screen are on the page (Issue 8, "Long conversations stay fast"): the list
// is virtualized by @tanstack/react-virtual over the conversation's own scroll area, every row is
// measured as it is drawn and again whenever it changes height (streaming text, a picture loading),
// and a row that did not change is not drawn again. Each session's measured heights are kept for
// when it is opened again, so its scroll position comes back exactly.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ForwardedRef, type ReactNode, type RefObject } from 'react';
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual';
import type { ChatMessage } from '@kestrel/server/model';
import { conversationRows, estimateRowHeight, shareRows, type ConversationRow } from '@kestrel/server/conversation-rows';
import { nextStepAtEnd } from '@kestrel/server/conversation-ends';
import { Message } from './Conversation.tsx';
import { RowView } from './ConversationRowView.tsx';
import { WorkingFoot, type ForkContext } from './TurnFoot.tsx';

/** Rows drawn beyond each edge of the screen, so a short scroll never shows an empty gap. */
const OVERSCAN_ROWS = 8;
/** The day line and where the session came from, before the first message. */
const HEAD_ESTIMATE_PX = 48;
const HEAD_KEY = 'head';

/** Each session's measured row heights, kept when its conversation leaves the page. View state only. */
const measured = new Map<string, VirtualItem[]>();

interface Props {
  messages: readonly ChatMessage[];
  sessionId: string;
  /** The conversation's scroll area. */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Whether the view follows the end of the conversation now (the reader has not scrolled up). */
  isFollowing: () => boolean;
  /** Where the session was left when the reader had scrolled up; absent: it opens at the end. */
  initialTop: number | undefined;
  /** Drawn before the first message, as the list's first row. */
  head: ReactNode;
  onChoice: (choice: string) => void;
  onReply: (text: string) => void;
  /** Put one of the user's sent messages back in the message box to edit. */
  onReuse: (text: string) => void;
  /** Drawn after the message at this index (the sub-agent card), whatever that message became. */
  anchorAt: number;
  anchored: ReactNode;
  /** The agent is working on the latest turn: its footer line says so (`workingText`) until it ends. */
  working: boolean;
  workingText: string;
  /** What each finished turn's Fork needs of the session; absent: no Fork. One object while it says the same. */
  fork?: ForkContext;
}

export interface MessageListHandle {
  /** Bring the card that waits for an answer into view. False when there is none. */
  scrollToPendingCard: () => boolean;
}

/** The rows, keeping the object of every row that draws the same as last time. */
function useRows(messages: readonly ChatMessage[], working: boolean, anchorAt: number): readonly ConversationRow[] {
  const last = useRef<readonly ConversationRow[]>([]);
  return useMemo(() => {
    const rows = shareRows(last.current, conversationRows(messages, working, anchorAt));
    last.current = rows;
    return rows;
  }, [messages, working, anchorAt]);
}

/** Where the list starts inside the scroll area (the area's padding), which the virtualizer counts from. */
function useListOffset(scrollRef: RefObject<HTMLDivElement | null>, list: RefObject<HTMLDivElement | null>): number {
  const [offset, setOffset] = useState(0);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const el = list.current;
    if (!scroller || !el) return;
    setOffset(Math.round(el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop));
  }, [scrollRef, list]);
  return offset;
}

/** Frames for the list to draw and measure the rows around a jump before the card in it is centred. */
const CARD_SETTLE_FRAMES = 3;

/** Runs `fn` after `frames` animation frames. */
function afterFrames(frames: number, fn: () => void): void {
  requestAnimationFrame(() => (frames <= 1 ? fn() : afterFrames(frames - 1, fn)));
}

const isPendingCard = (row: ConversationRow) => row.kind === 'message' && Boolean(row.message.input && !row.message.input.resolved);

interface ListOptions {
  rows: readonly ConversationRow[];
  sessionId: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  scrollMargin: number;
  isFollowing: () => boolean;
  initialTop: number | undefined;
}

/** The virtualizer over the rows. Item 0 is the head; item i is rows[i - 1]. */
function useRowVirtualizer({ rows, sessionId, scrollRef, scrollMargin, isFollowing, initialTop }: ListOptions) {
  // Changed only with the rows, so the virtualizer's layout is not worked out again on every scroll.
  const estimateSize = useCallback((i: number) => (i === 0 ? HEAD_ESTIMATE_PX : estimateRowHeight(rows[i - 1]!)), [rows]);
  const getItemKey = useCallback((i: number) => (i === 0 ? HEAD_KEY : rows[i - 1]!.key), [rows]);
  const getScrollElement = useCallback(() => scrollRef.current, [scrollRef]);
  const virtualizer = useVirtualizer({
    count: rows.length + 1,
    getScrollElement,
    estimateSize,
    getItemKey,
    overscan: OVERSCAN_ROWS,
    scrollMargin,
    initialMeasurementsCache: measured.get(sessionId),
    // Where the list starts: where the session was left, or past the end (the browser stops at the
    // end). The list writes it once it has the scroll area, so it is also where the rows are drawn from.
    initialOffset: () => initialTop ?? Number.MAX_SAFE_INTEGER,
  });
  // While the view follows the end, the conversation keeps the bottom in view itself; the list
  // moving the scroll position for a row above would read as the reader scrolling up.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, v) => {
    if (isFollowing()) return false;
    const offset = v.scrollOffset ?? 0;
    // The list's own rule: a row measured for the first time above the screen, or one wholly above it.
    return v.itemSizeCache.has(item.key) ? item.end <= offset && v.scrollDirection !== 'backward' : item.start < offset;
  };
  useEffect(() => () => void measured.set(sessionId, virtualizer.takeSnapshot()), [sessionId, virtualizer]);
  return virtualizer;
}

type RowVirtualizer = ReturnType<typeof useRowVirtualizer>;

/** What the conversation asks of the list: a jump to the card waiting for an answer. */
function useListHandle(ref: ForwardedRef<MessageListHandle>, rows: readonly ConversationRow[], virtualizer: RowVirtualizer, scrollRef: RefObject<HTMLDivElement | null>) {
  useImperativeHandle(
    ref,
    () => ({
      scrollToPendingCard: () => {
        const at = rows.findLastIndex(isPendingCard);
        if (at < 0) return false;
        // After the list has taken its starting place (the frame it is first drawn in). The row
        // may be taller than the screen, so once it is drawn the card itself is centred.
        afterFrames(1, () => {
          virtualizer.scrollToIndex(at + 1, { align: 'center' });
          afterFrames(CARD_SETTLE_FRAMES, () => void scrollRef.current?.querySelector('[data-pending-card]')?.scrollIntoView({ block: 'center' }));
        });
        return true;
      },
    }),
    [rows, virtualizer, scrollRef],
  );
}

export const MessageList = forwardRef<MessageListHandle, Props>(function MessageList({ messages, sessionId, scrollRef, isFollowing, initialTop, head, onChoice, onReply, onReuse, anchorAt, anchored, working, workingText, fork }, ref) {
  const rows = useRows(messages, working, anchorAt);
  const list = useRef<HTMLDivElement>(null);
  const scrollMargin = useListOffset(scrollRef, list);
  const virtualizer = useRowVirtualizer({ rows, sessionId, scrollRef, scrollMargin, isFollowing, initialTop });
  useListHandle(ref, rows, virtualizer, scrollRef);
  // An open next step is drawn at the end of the turn, not where the agent sent it (it may have
  // written more afterwards), and not at all until the turn ends (shared/conversation-ends.ts).
  const atEnd = useMemo(() => nextStepAtEnd(messages, working), [messages, working]);
  const items = virtualizer.getVirtualItems();
  const before = (items[0]?.start ?? scrollMargin) - scrollMargin;
  return (
    <>
      <div ref={list} className="message-list" style={{ height: virtualizer.getTotalSize() }}>
        <div style={{ height: before }} aria-hidden />
        {items.map((item) => (
          <div key={item.key} className="message-row" data-index={item.index} ref={virtualizer.measureElement}>
            {item.index === 0 ? head : <RowView row={rows[item.index - 1]!} sessionId={sessionId} onChoice={onChoice} onReply={onReply} onReuse={onReuse} anchored={rows[item.index - 1]!.anchored ? anchored : null} fork={fork} />}
          </div>
        ))}
      </div>
      {atEnd !== null && <Message key={`next-${messages[atEnd]!.id ?? atEnd}`} message={messages[atEnd]!} sessionId={sessionId} onChoice={onChoice} onReply={onReply} onReuse={onReuse} />}
      {/* A stable sibling: new message IDs must not remount the continuous thinking motion. */}
      {working && <WorkingFoot text={workingText} />}
      {anchorAt === messages.length - 1 && messages.length > 0 && anchored}
    </>
  );
});
