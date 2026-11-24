// One finding of a review, as both reviews draw it (2026-11-24: one component for the review of
// somebody else's pull request and the rounds review of a session's own work; the shape is
// shared/findings.ts). Its brief and fix stay in sight, with the explanation and the code it is
// about folded underneath. Under them, what the user can do with it: answer the reviewer's question
// about it, the card's own actions (edit and dismiss before posting a pull-request review; ask for a
// fix or dismiss in a rounds review), and talk it over in a sidebar beside the conversation. None of
// these waits on another, and none blocks the conversation.
import { memo, useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { ANSWER_MAX, BRIEF_MAX, findingAsideKey, findingSubject, FINDING_PRIORITIES, PRIORITY_LABEL, priorityMark, START_FINDING_ASIDE, type Finding, type FindingPriority } from '@kestrel/server/findings';
import { refText } from '@kestrel/server/diff-anchors';
import { actOnFinding, useAsideHost } from '../asides.ts';
import { AsideStart } from './AsideStart.tsx';
import { openReview } from '../reviewLinks.ts';
import { wantsNewTab } from '../route.ts';
import { Markdown } from './Markdown.tsx';
import { ReviewCommentCode } from './ReviewCommentCode.tsx';

/** Which card the finding is on: its actions follow. */
export type FindingCardKind = 'review' | 'rounds';

interface Props {
  finding: Finding;
  /** Its place among the findings shown, from 1; absent for a dismissed one. */
  number?: number;
  sessionId: string;
  /** The card's message id: actions and sidebars name the finding by card and id. */
  cardId: string;
  kind: FindingCardKind;
  /** Where the finding goes on the host, in words ("On the code at a.ts:4."); a pull-request review only. */
  place?: string;
  /** What became of it since the round before, in words; a rounds review only. */
  note?: string;
  /** The reviewer's session and the message the finding came from: a link opens it there. A rounds review only. */
  review?: { reviewerId: string; at?: string };
  /** Shown for the record only (a round of a rounds review the reviewer and the author passed between them): no actions, no answer box, no sidebar. */
  readOnly?: boolean;
  /** A pull-request review's draft: change the finding before posting. Absent once posted, and on a rounds card. */
  onChange?: (next: Finding) => void;
  disabled?: boolean;
}

/** A part that starts folded: its name is the button that opens it. */
function Fold({ label, children, startOpen = false }: { label: React.ReactNode; children: React.ReactNode; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  return (
    <div className="finding-fold">
      <button type="button" className="finding-fold-head" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
        {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
        {label}
      </button>
      {open && <div className="finding-fold-body">{children}</div>}
    </div>
  );
}

function Editor({ finding, onDone, disabled }: { finding: Finding; onDone: (next: Finding) => void; disabled: boolean }) {
  const [draft, setDraft] = useState(finding);
  const set = (change: Partial<Finding>) => setDraft((was) => ({ ...was, ...change }));
  const brief = draft.brief.trim();
  const problem = !brief ? 'Say what is wrong in a sentence or two.' : brief.length > BRIEF_MAX ? `The brief can be at most ${BRIEF_MAX} characters; the rest goes in the explanation.` : null;
  // Empty optional parts are left out, as the agent leaves them out.
  const done = () => {
    const { detail: _d, fix: _f, ...rest } = draft;
    onDone({ ...rest, brief, ...(draft.detail?.trim() ? { detail: draft.detail.trim() } : {}), ...(draft.fix?.trim() ? { fix: draft.fix.trim() } : {}) });
  };
  return (
    <div className="finding-edit">
      <div className="finding-edit-marks">
        <label>
          Priority
          <select className="form-control" value={draft.priority} disabled={disabled} onChange={(e) => set({ priority: e.target.value as FindingPriority })}>
            {FINDING_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="tag-rule-switch">
          <input type="checkbox" checked={draft.blocking} disabled={disabled} onChange={(e) => set({ blocking: e.target.checked })} />
          Blocks
        </label>
      </div>
      <label className="finding-edit-field">
        What is wrong
        <textarea className="form-control" rows={2} value={draft.brief} disabled={disabled} aria-invalid={problem !== null} onChange={(e) => set({ brief: e.target.value })} />
      </label>
      <label className="finding-edit-field">
        Technical explanation
        <textarea className="form-control" rows={4} value={draft.detail ?? ''} disabled={disabled} onChange={(e) => set({ detail: e.target.value })} />
      </label>
      <label className="finding-edit-field">
        Suggested fix
        <textarea className="form-control" rows={2} value={draft.fix ?? ''} disabled={disabled} onChange={(e) => set({ fix: e.target.value })} />
      </label>
      {problem && <p className="field-error" role="alert">{problem}</p>}
      <div className="finding-actions">
        <button type="button" className="secondary-button small" disabled={disabled || problem !== null} onClick={done}>
          Done
        </button>
        <button type="button" className="link-button" disabled={disabled} onClick={() => onDone(finding)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The reviewer's question about the finding, and the user's answer: a box until it is answered,
 * the answer after. The answer goes to the session the card is in as the user's message. What is
 * typed here is this box's own until it is sent.
 */
function Question({ finding, sessionId, cardId, disabled }: { finding: Finding; sessionId: string; cardId: string; disabled: boolean }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  if (!finding.question) return null;
  const answer = async () => {
    setSending(true);
    if (await actOnFinding(sessionId, cardId, finding.id, 'answer', text.trim())) setText('');
    setSending(false);
  };
  return (
    <div className="finding-question">
      <div className="finding-fix-label">Question for you</div>
      <div className="prose"><Markdown text={finding.question} sessionId={sessionId} /></div>
      {finding.answer ? (
        <div className="finding-answer">
          <span className="finding-fix-label">Your answer</span>
          <div className="prose"><Markdown text={finding.answer} sessionId={sessionId} /></div>
        </div>
      ) : (
        <div className="finding-answer-box">
          <textarea className="form-control" rows={2} aria-label="Your answer" placeholder="Your answer" value={text} maxLength={ANSWER_MAX} disabled={disabled || sending} onChange={(e) => setText(e.target.value)} />
          <button type="button" className="secondary-button small" disabled={disabled || sending || !text.trim()} onClick={() => void answer()}>
            {sending ? 'Sending…' : 'Answer'}
          </button>
        </div>
      )}
    </div>
  );
}

/** The card's own actions on the finding. */
function Actions({ finding, sessionId, cardId, kind, onChange, onEdit, disabled }: Props & { onEdit: () => void }) {
  const [busy, setBusy] = useState(false);
  const run = async (action: 'fix' | 'dismiss') => {
    setBusy(true);
    await actOnFinding(sessionId, cardId, finding.id, action);
    setBusy(false);
  };
  if (kind === 'review') {
    if (!onChange) return null;
    return (
      <>
        <button type="button" className="link-button" disabled={disabled} onClick={onEdit}>Edit</button>
        <button type="button" className="link-button" disabled={disabled} onClick={() => onChange({ ...finding, dismissed: true })}>Dismiss</button>
      </>
    );
  }
  return (
    <>
      {finding.fixAsked ? <span className="finding-done-note">Fix asked for</span> : <button type="button" className="link-button" disabled={disabled || busy} onClick={() => void run('fix')}>Ask to fix</button>}
      <button type="button" className="link-button" disabled={disabled || busy} onClick={() => void run('dismiss')}>Dismiss</button>
    </>
  );
}

export const FindingCard = memo(function FindingCard(props: Props) {
  const { finding, number, sessionId, cardId, kind, onChange, disabled = false } = props;
  const [editing, setEditing] = useState(false);
  // A sidebar opens in the pane column of the page this conversation is on; elsewhere there is none.
  const asideHere = useAsideHost()?.sessionId === sessionId;
  if (finding.dismissed) {
    const restore = kind === 'review' ? (onChange ? () => onChange({ ...finding, dismissed: false }) : null) : () => void actOnFinding(sessionId, cardId, finding.id, 'restore');
    return (
      <li className="finding dismissed">
        <span className="finding-brief">{finding.brief}</span>
        <span className="finding-dismissed-note">{kind === 'review' ? 'Excluded from review.' : 'Dismissed.'}</span>
        {restore && (
          <button type="button" className="link-button" disabled={disabled} onClick={restore}>
            Undo dismissal
          </button>
        )}
      </li>
    );
  }
  if (editing && onChange) {
    return (
      <li className="finding">
        <Editor finding={finding} disabled={disabled} onDone={(next) => (setEditing(false), next !== finding && onChange(next))} />
      </li>
    );
  }
  const priority = priorityMark(finding.priority);
  return (
    <li className="finding">
      <div className="finding-title">
        <span className={`finding-priority ${priority.kind}`} title={`${priority.label} priority`}>
          {priority.label}
        </span>
        <div className="prose finding-brief">
          <Markdown text={finding.brief} sessionId={sessionId} />
        </div>
      </div>
      <div className="finding-head">
        <span className="finding-mark">
          {finding.blocking && <span className="finding-blocks">Blocks</span>}
          {number !== undefined && <span className="finding-number">Finding {number}</span>}
          {finding.since !== undefined && <span className="finding-since">Open since round {finding.since}</span>}
          {finding.unstructured && <span className="finding-since" title={finding.unstructured}>Unstructured</span>}
        </span>
        <span className="finding-actions">
          {!props.readOnly && <Actions {...props} onEdit={() => setEditing(true)} />}
        </span>
      </div>
      {finding.fix && (
        <div className="finding-fix">
          <div className="finding-fix-label">Suggested fix</div>
          <div className="prose"><Markdown text={finding.fix} sessionId={sessionId} /></div>
        </div>
      )}
      <Question finding={finding} sessionId={sessionId} cardId={cardId} disabled={disabled || props.readOnly === true} />
      {finding.detail && (
        <Fold label="Why this happens" startOpen={finding.blocking}>
          <div className="prose">
            <Markdown text={finding.detail} sessionId={sessionId} />
          </div>
        </Fold>
      )}
      {finding.refs.map((ref) => (
        <Fold key={refText(ref)} label={
          <span className="finding-reference" title={refText(ref)}>
            <span className="finding-reference-file">{refText({ ...ref, path: ref.path.split('/').at(-1)! })}</span>
            {ref.path.includes('/') && <span className="finding-reference-directory">{ref.path.slice(0, ref.path.lastIndexOf('/'))}</span>}
          </span>
        }>
          <ReviewCommentCode sessionId={sessionId} path={ref.path} line={ref.line} />
        </Fold>
      ))}
      {props.place && <p className="finding-place">{props.place}</p>}
      {props.note && <p className="finding-place">{props.note}</p>}
      {finding.unstructured && <p className="finding-place">{finding.unstructured}</p>}
      {((asideHere && !props.readOnly) || props.review) && (
        <div className="finding-foot">
          {asideHere && !props.readOnly && <AsideStart sessionId={sessionId} at={cardId} asideKey={findingAsideKey(cardId, finding.id)} subject={findingSubject(finding, number)} label={START_FINDING_ASIDE} />}
          {props.review && (
            <button type="button" className="link-button" title="Open the reviewer's conversation where this finding was made" onClick={(e) => openReview(props.review!.reviewerId, props.review!.at, wantsNewTab(e))}>
              <ExternalLink aria-hidden /> Open in the review
            </button>
          )}
        </div>
      )}
    </li>
  );
});
