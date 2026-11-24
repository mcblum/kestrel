// A finished review of somebody else's pull request, handed over by the agent with `post_review`
// (server: shared/review-reply.ts, review-requests/reply.ts). Until it is posted the verdict and
// the summary and each finding can be changed here, and a finding dismissed (FindingCard.tsx, the one
// finding component both reviews use);
// Post review sends what is kept to the host as it stands; an approval may go up alone, and one over
// blocking findings is confirmed first (ApproveOverBlocking). Once posted it
// only says what went up. The card itself is server data and comes from the conversation; what is
// typed here before posting is a draft of this card's own.
import { memo, useEffect, useRef, useState } from 'react';
import { Check, Eye, TriangleAlert } from 'lucide-react';
import { blockingFindings, isCleanApproval, keptFindings, postable, postedSummary, VERDICT_LABEL, VERDICT_POSTED, verdictFor, type ReviewFinding, type ReviewReply, type ReviewVerdict } from '@kestrel/server/review-reply';
import { countLine, numberedFindings, type Finding } from '@kestrel/server/findings';
import { placeFinding, placementText } from '@kestrel/server/diff-anchors';
import { act, call } from '../store.ts';
import { DialogShell } from './DialogShell.tsx';
import { Markdown } from './Markdown.tsx';
import { FindingCard } from './FindingCard.tsx';

interface Props {
  review: ReviewReply;
  sessionId: string;
  cardId: string;
}

/** Asked before an approval is posted while the review still holds findings marked blocking. */
function ApproveOverBlocking({ blocking, withoutComment, onClose, onApprove }: { blocking: readonly ReviewFinding[]; withoutComment: boolean; onClose: () => void; onApprove: () => void }) {
  const n = blocking.length;
  const actions = (
    <button type="button" className="pr-merge-confirm worktree-discard" onClick={onApprove}>
      <Check size={15} aria-hidden />
      Approve anyway
    </button>
  );
  return (
    <DialogShell icon={<TriangleAlert size={20} aria-hidden />} eyebrow="REVIEW" title={`Approve with ${n === 1 ? 'a blocking finding' : `${n} blocking findings`}?`} busy={false} danger onClose={onClose} actions={actions}>
      <p className="worktree-summary">The review found {n === 1 ? 'a problem' : `${n} problems`} it thinks must be fixed before this merges:</p>
      <ul className="worktree-commits review-approve-blocking">
        {blocking.map((f) => <li key={f.id}><span>{f.brief}</span></li>)}
      </ul>
      <p className="worktree-warning">{withoutComment ? 'Only the approval is posted. The author is not told about ' + (n === 1 ? 'it' : 'them') + '.' : 'The approval is posted with the summary and the findings as comments, still marked blocking.'}</p>
    </DialogShell>
  );
}

export const ReviewReplyCard = memo(function ReviewReplyCard({ review, sessionId, cardId }: Props) {
  const [verdict, setVerdict] = useState(review.verdict);
  const [summary, setSummary] = useState(review.summary);
  const [editing, setEditing] = useState(false);
  const [posting, setPosting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  // Which of the two approvals: the user's pick, or until they pick, without comment when nothing is kept to say.
  const [bare, setBare] = useState<boolean | null>(null);
  const [confirming, setConfirming] = useState(false);
  const posted = review.posted;
  const box = useRef<HTMLTextAreaElement>(null);
  // The box takes the cursor and comes into view as it opens.
  useEffect(() => {
    if (!editing) return;
    box.current?.focus();
    box.current?.scrollIntoView({ block: 'nearest' });
  }, [editing]);
  // The findings as the user has left them: reworded, re-marked, dismissed. A draft of this card's own until it is posted.
  const [findings, setFindings] = useState<readonly ReviewFinding[]>(review.findings ?? []);
  // The verdict follows the findings (asking for changes while one blocks) until the user picks one themselves.
  const [picked, setPicked] = useState(false);
  const changeFinding = (next: ReviewFinding) => {
    const after = findings.map((f) => (f.id === next.id ? next : f));
    setFindings(after);
    if (!picked) setVerdict(verdictFor(review.verdict, after));
  };
  // What only Kestrel sets on a finding (the answer to its question) comes from the card as the server has it, not the draft.
  const own = new Map((review.findings ?? []).map((f) => [f.id, f]));
  const withMarks = (f: ReviewFinding): ReviewFinding => {
    const server = own.get(f.id);
    return server?.answer && !f.answer ? { ...f, answer: server.answer } : f;
  };
  // Blocking and high priority first; the dismissed ones last. What is posted follows the same order.
  // Each kept finding has a number, in the order shown, so one can be told from the next and spoken of.
  const { shown: ordered, numberOf } = numberedFindings(posted ? keptFindings(review.findings ?? []) : findings.map(withMarks));
  const shownFindings = ordered;

  const included = keptFindings(findings).length;
  const withoutComment = verdict === 'approve' && (bare ?? isCleanApproval(verdict, findings));
  const blocking = blockingFindings(findings);
  // Where each kept finding goes on the host (shared/diff-anchors.ts): said before posting, and after it where the host moved one.
  const whereItGoes = (f: Finding): string | undefined => {
    if (f.dismissed || withoutComment || posted?.withoutComment) return undefined;
    const moved = posted?.moved?.[f.id];
    if (moved) return `In the summary, because ${moved}.`;
    const text = placementText(placeFinding(f, review.anchors));
    return posted ? text.replace(/^On the code at (.*?)(, if the host takes it there)?\.$/, 'Posted on the code at $1.').replace(/^In the summary,/, 'Posted in the summary,') : text;
  };
  const outgoing = previewing ? postable({ summary, findings: [...findings], anchors: review.anchors }, withoutComment) : null;

  const post = async () => {
    setPosting(true);
    // The posted card comes back through the conversation; a refusal is shown by `act`.
    await act(() => call<ReviewReply>(`/api/sessions/${sessionId}/review-reply`, { method: 'POST', body: JSON.stringify({ cardId, verdict, summary, findings, withoutComment }) }));
    setPosting(false);
  };
  // Approving over findings the review marked blocking is the user's call, made knowingly.
  const submit = () => (verdict === 'approve' && blocking.length > 0 ? setConfirming(true) : void post());

  return (
    <div className="review-reply" role="group" aria-label="Review">
      <div className="review-reply-head">
        <Eye aria-hidden />
        <span className="review-reply-title">Review of {review.sha.slice(0, 7)}</span>
        {posted ? (
          <span className="review-reply-posted">
            <Check aria-hidden /> Posted as {VERDICT_POSTED[posted.verdict]}
            {posted.onItsOwn ? ', on its own' : ''}
          </span>
        ) : null}
      </div>
      {!posted && <div className="review-reply-decision"><strong>{verdict === 'request_changes' ? 'Changes recommended' : verdict === 'approve' ? 'Approval recommended' : 'Review comments'}</strong><span>{picked ? 'Your verdict' : 'Agent recommendation'}</span></div>}
      {/* The summary and the way to edit it are one block: the button sits under the text it changes, and the box opens where it was (Matt, 2026-11-21: the button was at the card's foot, a screen or more below the box it opened). */}
      {posted && (posted.withoutComment || !review.summary) && <p className="review-reply-note">Approved without a comment. {keptFindings(review.findings ?? []).length > 0 ? 'The summary and the findings stayed in Kestrel.' : 'The summary stayed in Kestrel.'}</p>}
      {!posted && withoutComment && <p className="review-reply-note">{included > 0 ? 'The summary and the findings are for you and stay in Kestrel.' : 'This summary is for you and stays in Kestrel.'} Only the approval is posted.</p>}
      {editing && !posted ? (
        <div className="review-reply-editing">
          <textarea ref={box} aria-label="Summary" className="form-control review-reply-edit" rows={Math.min(18, Math.max(6, summary.split('\n').length + 1))} value={summary} disabled={posting} onChange={(e) => setSummary(e.target.value)} />
          <button type="button" className="secondary-button small" disabled={posting} onClick={() => setEditing(false)}>
            Done editing
          </button>
        </div>
      ) : (
        <div className="review-reply-summary-block">
          <div className="prose review-reply-summary">
            <Markdown text={posted ? review.summary : summary} sessionId={sessionId} />
          </div>
          {!posted && (
            <button type="button" className="link-button review-reply-edit-link" disabled={posting} onClick={() => setEditing(true)}>
              Edit summary
            </button>
          )}
        </div>
      )}
      {findings.length > 0 && (
        <>
          <div className="review-reply-count">{countLine(findings)}</div>
          <ul className="review-reply-findings">
            {shownFindings.map((f) => (
              <FindingCard key={f.id} finding={f} number={numberOf.get(f.id)} sessionId={sessionId} cardId={cardId} kind="review" disabled={posting} place={whereItGoes(f)} {...(posted ? {} : { onChange: changeFinding })} />
            ))}
          </ul>
        </>
      )}
      {posted?.note && <p className="review-reply-note">{posted.note}</p>}
      {!posted && outgoing && (
        <section className="review-reply-preview" aria-label="Submission preview">
          <h3>Submission preview</h3>
          <p className="review-reply-note">{withoutComment ? 'Approval only. No summary or comments will be posted.' : `${VERDICT_LABEL[verdict]} · Summary and ${outgoing.comments.length} comment${outgoing.comments.length === 1 ? '' : 's'} on the code. A comment the host refuses after all goes under the summary instead.`}</p>
          <div className="prose"><Markdown text={postedSummary(outgoing)} sessionId={sessionId} /></div>
          {outgoing.comments.map((comment, i) => <div className="review-preview-comment" key={i}>
            <code>{comment.path}:{comment.start !== undefined ? `${comment.start}–` : ''}{comment.line}</code>
            <div className="prose"><Markdown text={comment.body} sessionId={sessionId} /></div>
          </div>)}
        </section>
      )}
      {!posted && (
        <div className="review-reply-foot">
          <span className="review-reply-note" role="status">{withoutComment ? `Draft approval · No comment${included > 0 ? ` · ${included} finding${included === 1 ? '' : 's'} not posted` : ''}` : `Draft review · ${included} finding${included === 1 ? '' : 's'} included`}</span>
          <button type="button" className="link-button" aria-expanded={previewing} onClick={() => setPreviewing(!previewing)}>{previewing ? 'Hide preview' : 'Preview'}</button>
          {/* What it is posted as sits beside the button that posts it (Matt, 2026-11-21). */}
          <select aria-label="Verdict" className="form-control review-reply-verdict" value={withoutComment ? 'approve_without_comment' : verdict} disabled={posting} onChange={(e) => {
            const choice = e.target.value;
            setPicked(true);
            setBare(choice === 'approve_without_comment' ? true : choice === 'approve' ? false : null);
            setVerdict(choice === 'approve_without_comment' ? 'approve' : choice as ReviewVerdict);
          }}>
            <option value="comment">Comment</option>
            <option value="approve_without_comment">Approve without comment</option>
            <option value="approve">Approve with summary</option>
            <option value="request_changes">Request changes</option>
          </select>
          <button type="button" className="primary-button small" disabled={posting || (!withoutComment && !summary.trim())} onClick={submit}>
            {posting ? 'Submitting…' : verdict === 'approve' ? 'Approve' : 'Submit review'}
          </button>
        </div>
      )}
      {confirming && <ApproveOverBlocking blocking={blocking} withoutComment={withoutComment} onClose={() => setConfirming(false)} onApprove={() => (setConfirming(false), void post())} />}
    </div>
  );
});
