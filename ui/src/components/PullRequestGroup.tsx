// The request pill for a session with more than one pull or merge request: a grey "3 PRs ▾" button
// with a thin strip along its bottom, one equal segment per request in its status colour, and a
// popover listing each request (number, title, status) with the single pill's separate targets
// (PullRequestParts.tsx). Hover opens it, with a short close delay so the pointer can reach it; a
// click on the pill pins it until Escape, a press outside, or a second click. Enter or Space opens
// and pins it and moves focus in; Escape closes it and returns focus to the pill. While a Merge
// now confirmation is open the popover stays. Kept inside the window by usePopupPlacement.
// `compact` is the pill's smaller size (pull-request-group.css), used for the requests of the sessions a
// session brought in (BroughtInRequests.tsx); `sessionOf` then names each request's session in its row.
import { useEffect, useId, useMemo, useRef, useState, type FocusEvent, type MouseEvent } from 'react';
import { ChevronDown, GitPullRequest } from 'lucide-react';
import { pullRequestStatus, type PullRequest } from '@kestrel/server/details';
import type { HostTerms } from '@kestrel/server/host-terms';
import { groupDescription, groupLabel, groupOrder, stripSegments } from '@kestrel/server/request-group';
import { requestParts, useMergeConfirmation } from './PullRequestParts.tsx';
import { rectOf, usePopupPlacement } from './usePopupPlacement.ts';
import '../styles/pull-request-group.css';

/** How long the popover waits after the pointer leaves before closing, so it can travel into it. */
const HOVER_CLOSE_DELAY_MS = 220;
/** Space between the pill and the popover. */
const POPOVER_GAP = 4;
/** What a press inside the popover can focus first. */
const FOCUSABLE = 'button:not(:disabled), a[href]';

type Mode = 'closed' | 'hover' | 'pinned';

interface Props {
  pullRequests: readonly PullRequest[];
  terms: HostTerms;
  onOpen: (pr: PullRequest) => void;
  sessionId?: string;
  onRefresh?: () => void;
  /** The smaller size of the pill. */
  compact?: boolean;
  /** The session a request belongs to, named in its row, where the requests are not all this session's. */
  sessionOf?: (pr: PullRequest) => string | undefined;
  /** What the popover is called; "Pull requests for this session" unless given. */
  popoverLabel?: string;
}

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

/** One request in the popover: its number, title and status, each target separate. */
function GroupRow({ pr, terms, onOpen, onMerge, session }: { pr: PullRequest; terms: HostTerms; onOpen: (pr: PullRequest) => void; onMerge?: (pr: PullRequest, label: string) => void; session?: string }) {
  const parts = requestParts({ pr, terms, onOpen, onMerge });
  return (
    <li className="pr-group-row">
      {parts.number}
      <span className="pr-group-title" title={session ? `${pr.title} · ${session}` : pr.title}>
        {pr.title}
        {session && <span className="pr-group-session">{session}</span>}
      </span>
      {parts.external}
      <span className={`pr-group-status pr-tone-${pullRequestStatus(pr).tone}`}>{parts.status}</span>
    </li>
  );
}

/** Open, pinned or closed, with the hover close delay. */
function usePopoverMode() {
  const [mode, setMode] = useState<Mode>('closed');
  const timer = useRef<number | undefined>(undefined);
  const cancelClose = () => window.clearTimeout(timer.current);
  useEffect(() => cancelClose, []);
  return {
    mode,
    setMode,
    cancelClose,
    hoverIn: () => { cancelClose(); setMode((m) => (m === 'closed' ? 'hover' : m)); },
    hoverOut: () => { cancelClose(); timer.current = window.setTimeout(() => setMode((m) => (m === 'hover' ? 'closed' : m)), HOVER_CLOSE_DELAY_MS); },
  };
}

export function PullRequestGroup({ pullRequests, terms, onOpen, sessionId, onRefresh, compact = false, sessionOf, popoverLabel }: Props) {
  const popover = usePopoverMode();
  const { mode, setMode } = popover;
  const merge = useMergeConfirmation(sessionId, onRefresh);
  const wrap = useRef<HTMLSpanElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef(false);
  const popId = useId();
  const ordered = useMemo(() => groupOrder(pullRequests), [pullRequests]);
  const segments = useMemo(() => stripSegments(terms, pullRequests), [terms, pullRequests]);
  const isOpen = mode !== 'closed' || merge.open;

  usePopupPlacement(box, () => (pill.current ? { anchor: rectOf(pill.current), side: 'below', align: 'end', gap: POPOVER_GAP } : null), [isOpen]);

  const close = (returnFocus: boolean) => {
    popover.cancelClose();
    setMode('closed');
    if (returnFocus) pill.current?.focus();
  };

  // Escape and a press outside close it; neither while the merge confirmation is open (it is outside, and has its own Escape).
  useEffect(() => {
    if (!isOpen || merge.open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(true); };
    const onPress = (e: PointerEvent) => { if (!(e.target instanceof Node && wrap.current?.contains(e.target))) close(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPress, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPress, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `close` only uses refs and setters.
  }, [isOpen, merge.open]);

  // Opened from the keyboard: focus its first target.
  useEffect(() => {
    if (mode !== 'pinned' || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    box.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true });
  }, [mode]);

  const onPillClick = (e: MouseEvent) => {
    stop(e);
    popover.cancelClose();
    if (mode === 'pinned') return close(false);
    focusOnOpen.current = e.detail === 0; // Enter or Space
    setMode('pinned');
  };
  // Tabbing out of it closes it; focus moving into the merge confirmation does not.
  const onBlur = (e: FocusEvent) => {
    const next = e.relatedTarget;
    if (next instanceof Node && !wrap.current?.contains(next) && !merge.open) close(false);
  };
  const openRequest = (pr: PullRequest) => { close(false); onOpen(pr); };
  const onMerge = merge.onMerge && ((pr: PullRequest, label: string) => { setMode('pinned'); merge.onMerge?.(pr, label); });
  const description = groupDescription(terms, pullRequests);

  return (
    <span ref={wrap} className="pr-group" onMouseEnter={popover.hoverIn} onMouseLeave={popover.hoverOut} onBlur={onBlur} onClick={stop} onAuxClick={stop}>
      <button ref={pill} type="button" className={`pr-group-pill${compact ? ' compact' : ''}`} aria-haspopup="dialog" aria-expanded={isOpen} aria-controls={isOpen ? popId : undefined} aria-label={description} title={description} onClick={onPillClick}>
        <GitPullRequest aria-hidden />
        {groupLabel(terms, pullRequests.length)}
        <ChevronDown aria-hidden className="pr-group-chevron" />
        <span className="pr-group-strip" aria-hidden>
          {segments.map((s, i) => <span key={`${i}:${s.number}`} className={`pr-tone-${s.tone}`} />)}
        </span>
      </button>
      {isOpen && (
        <div ref={box} id={popId} className="pr-group-popover" role="dialog" aria-label={popoverLabel ?? `${terms.longTitle}s for this session`}>
          <ul className="pr-group-list">
            {ordered.map((pr, i) => <GroupRow key={`${i}:${pr.number}`} pr={pr} terms={terms} onOpen={openRequest} onMerge={onMerge} session={sessionOf?.(pr)} />)}
          </ul>
        </div>
      )}
      {merge.confirmation}
    </span>
  );
}
