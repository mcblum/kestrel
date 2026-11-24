// A round of the review of this session's own work. A round passed between reviewer and author is
// one quiet folded line; the round the review ended with is the full findings card, the findings as
// they finally stand (Matt, 2026-11-24). Server: shared/round-findings.ts, delegation.ts
// `reviewStep`. The card holds the reviewer's summary and its findings, drawn by the same finding
// component as a pull-request review (FindingCard.tsx). From the second round it says what became
// of each finding of the round before (fixed, still open, withdrawn, and what the author says it
// fixed and where); a finding still open is the same finding, with its number, marked with the
// round it was first raised in. They warn and never block: the card asks nothing of the
// conversation, and each finding can be answered, sent to be fixed, dismissed, or talked over in a
// sidebar at any time. "Open the review" opens the reviewer's conversation where the round ended.
// The card is server data from the conversation; every action goes to the server and comes back in it.
import { memo, useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, Eye } from 'lucide-react';
import { countLine } from '@kestrel/server/findings';
import { earlierText, roundNumbered, type RoundFindings } from '@kestrel/server/round-findings';
import { OPEN_REVIEW, openReview } from '../reviewLinks.ts';
import { wantsNewTab } from '../route.ts';
import { FindingCard } from './FindingCard.tsx';
import { Markdown } from './Markdown.tsx';

interface Props {
  round: RoundFindings;
  sessionId: string;
  cardId: string;
}

export function OpenReviewButton({ reviewerId, at }: { reviewerId: string; at?: string }) {
  return (
    <button type="button" className="link-button review-open" title="Open the reviewer's conversation where it handed these over" onClick={(e) => openReview(reviewerId, at, wantsNewTab(e))}>
      <ExternalLink aria-hidden /> {OPEN_REVIEW}
    </button>
  );
}

/**
 * A round the reviewer and the author passed between them, before the findings were final: one quiet
 * line that unfolds to what was handed over, for the record. Nothing on it asks anything of the user.
 */
function PassedRound({ round, sessionId, cardId }: Props) {
  const [open, setOpen] = useState(false);
  const kept = round.findings.filter((f) => !f.dismissed).length;
  return (
    <div className="review-round-line">
      <div className="suggestion-line">
        <button type="button" className="review-round-fold" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
          {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
          Round {round.round} of {round.rounds}: {round.reviewer} passed {kept === 1 ? '1 finding' : `${kept} findings`} to the author
        </button>
        <OpenReviewButton reviewerId={round.reviewerId} {...(round.at ? { at: round.at } : {})} />
      </div>
      {open && <FinalRound round={round} sessionId={sessionId} cardId={cardId} readOnly />}
    </div>
  );
}

export const RoundFindingsCard = memo(function RoundFindingsCard(props: Props) {
  return props.round.final ? <FinalRound {...props} /> : <PassedRound {...props} />;
});

/** The findings as they stand at the end of the review: the full card, with every finding's actions. */
function FinalRound({ round, sessionId, cardId, readOnly = false }: Props & { readOnly?: boolean }) {
  const { shown, numberOf } = roundNumbered(round.findings);
  const fateOf = new Map((round.earlier ?? []).map((e) => [e.id, e]));
  // What became of the round before's findings that are not on this card: fixed or withdrawn.
  const settled = (round.earlier ?? []).filter((e) => e.status === 'fixed' || e.status === 'withdrawn');
  const review = { reviewerId: round.reviewerId, ...(round.at ? { at: round.at } : {}) };
  return (
    <div className="review-reply" role="group" aria-label="Review findings">
      <div className="review-reply-head">
        <Eye aria-hidden />
        <span className="review-reply-title">Review by {round.reviewer}</span>
        <span className="review-reply-round">Round {round.round} of {round.rounds}</span>
        <OpenReviewButton {...review} />
      </div>
      <div className="review-reply-decision">
        <strong>{round.verdict === 'clean' ? (round.earlier?.length ? 'Nothing left to change' : 'Nothing must change') : 'Changes recommended'}</strong>
        <span>A second opinion: it warns and never blocks</span>
      </div>
      {round.summary && (
        <div className="prose review-reply-summary">
          <Markdown text={round.summary} sessionId={sessionId} />
        </div>
      )}
      {settled.length > 0 && (
        <ul className="review-earlier" aria-label="Since the round before">
          {settled.map((e) => (
            <li key={e.id}>
              <span className={`review-earlier-mark ${e.status}`}>{e.status === 'fixed' ? 'Fixed' : 'Withdrawn'}</span>
              <span className="review-earlier-text">
                {earlierText(e)} <span className="review-earlier-brief">{e.brief}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {round.findings.length > 0 && (
        <>
          <div className="review-reply-count">{countLine(round.findings)}</div>
          <ul className="review-reply-findings">
            {shown.map((f) => {
              const fate = fateOf.get(f.id);
              return <FindingCard key={f.id} finding={f} number={numberOf.get(f.id)} sessionId={sessionId} cardId={cardId} kind="rounds" review={review} readOnly={readOnly} {...(fate ? { note: earlierText(fate) } : {})} />;
            })}
          </ul>
        </>
      )}
    </div>
  );
}
