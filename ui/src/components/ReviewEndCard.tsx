// How the review of this session's own work ended with findings still open (server:
// shared/round-findings.ts `ReviewEnd`, review-end.ts; Matt, 2026-11-24: a warning line scrolls away).
// While open it is a card at the foot of the conversation, above the message box, in the same stack
// as an open suggestion: the open findings by priority, each with its own actions (choose it to be
// fixed, dismiss it, start a sidebar about it, open it in the review), and the card's (ask for the
// chosen ones to be fixed, open the review, carry on). Where the review ended, one quiet line stays,
// with a link to the review and, once put away, a way to bring the card back. The findings are read
// from the last round's card, the one copy; nothing here blocks: findings warn, never block.
import { memo, useMemo, useState } from 'react';
import { Eye, X } from 'lucide-react';
import type { ChatMessage } from '@kestrel/server/model';
import { countLine, findingAsideKey, findingSubject, priorityMark } from '@kestrel/server/findings';
import { openFindings, reviewEndLine, shownReviewEnd, type ReviewEnd } from '@kestrel/server/round-findings';
import { actOnFinding } from '../asides.ts';
import { OPEN_REVIEW, openReview, reviewEndActions } from '../reviewLinks.ts';
import { wantsNewTab } from '../route.ts';
import { AsideStart } from './AsideStart.tsx';
import { useApp } from '../store.ts';
import { OpenReviewButton } from './RoundFindingsCard.tsx';

function Dock({ sessionId, cardId, end, messages }: { sessionId: string; cardId: string; end: ReviewEnd; messages: readonly ChatMessage[] }) {
  const { findings, numberOf } = useMemo(() => openFindings(messages, end), [messages, end]);
  // Chosen to be fixed: what blocks, to begin with; a finding already sent to be fixed cannot be chosen again.
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(findings.filter((f) => f.blocking && !f.fixAsked).map((f) => f.id)));
  const [busy, setBusy] = useState(false);
  const picked = findings.filter((f) => chosen.has(f.id) && !f.fixAsked).map((f) => f.id);
  const toggle = (id: string) => setChosen((was) => (was.has(id) ? new Set([...was].filter((x) => x !== id)) : new Set([...was, id])));
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    await work();
    setBusy(false);
  };
  return (
    <div className="review-end-card" role="group" aria-label="Review findings still open">
      <div className="suggestion-head">
        <Eye className="suggestion-icon" aria-hidden />
        <span className="suggestion-title">
          {end.reviewer} still has findings
        </span>
        <button type="button" className="suggestion-x" aria-label="Carry on" title="Carry on: put this card away. The findings stay on the round cards." disabled={busy} onClick={() => void run(() => reviewEndActions.close(sessionId, cardId))}>
          <X aria-hidden />
        </button>
      </div>
      <p className="suggestion-reason">
        {findings.length > 0 ? countLine(findings) : 'No finding is left open.'} · They warn and never block.{end.problem ? ` ${end.problem}` : ''}
      </p>
      {findings.length > 0 && (
        <ul className="review-end-findings">
          {findings.map((f) => {
            const priority = priorityMark(f.priority);
            const number = numberOf.get(f.id);
            return (
              <li key={f.id} className="review-end-finding">
                <input type="checkbox" aria-label={`Ask to fix finding ${number}`} checked={chosen.has(f.id) && !f.fixAsked} disabled={busy || f.fixAsked === true} onChange={() => toggle(f.id)} />
                <span className={`finding-priority ${priority.kind}`}>{priority.label}</span>
                <span className="review-end-brief" title={f.brief}>
                  {f.brief}
                </span>
                <span className="review-end-marks">
                  {f.blocking && <span className="finding-blocks">Blocks</span>}
                  <span className="finding-number">Finding {number}</span>
                  {f.fixAsked && <span className="finding-done-note">Fix asked for</span>}
                </span>
                <span className="review-end-actions">
                  <button type="button" className="link-button" disabled={busy} onClick={() => void run(() => actOnFinding(sessionId, end.card!, f.id, 'dismiss'))}>
                    Dismiss
                  </button>
                  <AsideStart sessionId={sessionId} at={end.card!} asideKey={findingAsideKey(end.card!, f.id)} subject={findingSubject(f, number)} />
                  <button type="button" className="link-button" title="Open the reviewer's conversation where this finding was made" onClick={(e) => openReview(end.reviewerId, end.at, wantsNewTab(e))}>
                    In the review
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <div className="suggestion-buttons">
        {findings.length > 0 && (
          <button type="button" className="suggestion-primary" disabled={busy || picked.length === 0} onClick={() => void run(() => reviewEndActions.fix(sessionId, cardId, picked))}>
            {picked.length === 0 ? 'Ask to fix the chosen' : `Ask to fix ${picked.length === 1 ? 'the chosen one' : `these ${picked.length}`}`}
          </button>
        )}
        <button type="button" className="suggestion-quiet" onClick={(e) => openReview(end.reviewerId, end.at, wantsNewTab(e))}>
          {OPEN_REVIEW}
        </button>
        <button type="button" className="suggestion-quiet" disabled={busy} onClick={() => void run(() => reviewEndActions.close(sessionId, cardId))}>
          Carry on
        </button>
      </div>
    </div>
  );
}

/** The open review-end card of a session, above the message box; nothing when there is none. */
export const ReviewEndDock = memo(function ReviewEndDock({ sessionId, messages }: { sessionId: string; messages: readonly ChatMessage[] | undefined }) {
  const shown = useMemo(() => shownReviewEnd(messages), [messages]);
  if (!shown || !messages) return null;
  return <Dock key={shown.id} sessionId={sessionId} cardId={shown.id} end={shown.end} messages={messages} />;
});

/** What stays in the conversation where the review ended: one quiet line, the link to the review, and Show again once put away. */
export const ReviewEndLine = memo(function ReviewEndLine({ sessionId, cardId, end }: { sessionId: string; cardId: string; end: ReviewEnd }) {
  const open = useApp((s) => openFindings(s.details.get(sessionId)?.messages ?? [], end).findings.length);
  return (
    <div className="suggestion-line review-end-line" role="note">
      <Eye aria-hidden />
      <span>{reviewEndLine(end, open)}</span>
      <OpenReviewButton reviewerId={end.reviewerId} {...(end.at ? { at: end.at } : {})} />
      {end.state === 'closed' && (
        <button type="button" className="suggestion-undo" onClick={() => void reviewEndActions.reopen(sessionId, cardId)}>
          Show the card again
        </button>
      )}
    </div>
  );
});
