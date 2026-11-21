// A finished review of somebody else's pull request, handed over by the agent with `post_review`
// (server: shared/review-reply.ts, review-requests/reply.ts). Until it is posted the verdict and
// the summary can be changed here; Post review sends it to the host as it stands. Once posted it
// only says what went up. The card itself is server data and comes from the conversation; what is
// typed here before posting is a draft of this card's own.
import { memo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Eye } from 'lucide-react';
import { REVIEW_VERDICTS, VERDICT_LABEL, VERDICT_POSTED, type ReviewReply, type ReviewVerdict } from '@kestrel/server/review-reply';
import { act, call } from '../store.ts';
import { Markdown } from './Markdown.tsx';
import { ReviewCommentCode } from './ReviewCommentCode.tsx';

interface Props {
  review: ReviewReply;
  sessionId: string;
  cardId: string;
}

const POST_LABEL: Record<ReviewVerdict, string> = { comment: 'Post comment', approve: 'Post approval', request_changes: 'Post request for changes' };

export const ReviewReplyCard = memo(function ReviewReplyCard({ review, sessionId, cardId }: Props) {
  const [verdict, setVerdict] = useState(review.verdict);
  const [summary, setSummary] = useState(review.summary);
  const [editing, setEditing] = useState(false);
  const [posting, setPosting] = useState(false);
  const posted = review.posted;
  // Which comments have their code open: what this card shows, not server data.
  const [shown, setShown] = useState<ReadonlySet<number>>(new Set());
  const toggle = (i: number) => setShown((was) => new Set(was.has(i) ? [...was].filter((x) => x !== i) : [...was, i]));

  const post = async () => {
    setPosting(true);
    // The posted card comes back through the conversation; a refusal is shown by `act`.
    await act(() => call<ReviewReply>(`/api/sessions/${sessionId}/review-reply`, { method: 'POST', body: JSON.stringify({ cardId, verdict, summary }) }));
    setPosting(false);
  };

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
        ) : (
          <select aria-label="Verdict" className="form-control review-reply-verdict" value={verdict} disabled={posting} onChange={(e) => setVerdict(e.target.value as ReviewVerdict)}>
            {REVIEW_VERDICTS.map((v) => (
              <option key={v} value={v}>
                {VERDICT_LABEL[v]}
              </option>
            ))}
          </select>
        )}
      </div>
      {editing && !posted ? (
        <textarea aria-label="Summary" className="form-control review-reply-edit" rows={Math.min(18, Math.max(6, summary.split('\n').length + 1))} value={summary} disabled={posting} onChange={(e) => setSummary(e.target.value)} />
      ) : (
        <div className="prose review-reply-summary">
          <Markdown text={posted ? review.summary : summary} sessionId={sessionId} />
        </div>
      )}
      {review.comments.length > 0 && (
        <ul className="review-reply-comments">
          {review.comments.map((c, i) => {
            const open = shown.has(i);
            return (
              <li key={`${c.path}:${c.line}:${i}`}>
                <button type="button" className="review-reply-where" aria-expanded={open} title={open ? 'Hide the code' : 'Show the code at this line'} onClick={() => toggle(i)}>
                  {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
                  <code>
                    {c.path}:{c.line}
                  </code>
                </button>
                {open && <ReviewCommentCode sessionId={sessionId} path={c.path} line={c.line} />}
                <div className="prose">
                  <Markdown text={c.body} sessionId={sessionId} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {posted?.note && <p className="review-reply-note">{posted.note}</p>}
      {!posted && (
        <div className="review-reply-foot">
          <span className="review-reply-note">Nothing has been posted.</span>
          <button type="button" className="secondary-button small" disabled={posting} onClick={() => setEditing((was) => !was)}>
            {editing ? 'Done editing' : 'Edit summary'}
          </button>
          <button type="button" className="primary-button small" disabled={posting || !summary.trim()} onClick={() => void post()}>
            {posting ? 'Posting…' : POST_LABEL[verdict]}
          </button>
        </div>
      )}
    </div>
  );
});
