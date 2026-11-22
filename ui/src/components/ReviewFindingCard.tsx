// A finding keeps its brief and fix visible, with supporting evidence underneath.
import { memo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { BRIEF_MAX, FINDING_PRIORITIES, PRIORITY_LABEL, type FindingPriority, type ReviewFinding } from '@kestrel/server/review-reply';
import { Markdown } from './Markdown.tsx';

import { ReviewCommentCode } from './ReviewCommentCode.tsx';

interface Props {
  finding: ReviewFinding;
  /** Its place among the findings shown, from 1; absent for a dismissed one. */
  number?: number;
  sessionId: string;
  /** Absent once the review is posted: the card then only shows what went up. */
  onChange?: (next: ReviewFinding) => void;
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

function Editor({ finding, onDone, disabled }: { finding: ReviewFinding; onDone: (next: ReviewFinding) => void; disabled: boolean }) {
  const [draft, setDraft] = useState(finding);
  const set = (change: Partial<ReviewFinding>) => setDraft((was) => ({ ...was, ...change }));
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
          Blocking
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

export const ReviewFindingCard = memo(function ReviewFindingCard({ finding, number, sessionId, onChange, disabled = false }: Props) {
  const [editing, setEditing] = useState(false);
  if (finding.dismissed) {
    return (
      <li className="finding dismissed">
        <span className="finding-brief">{finding.brief}</span>
        <span className="finding-dismissed-note">Excluded from review.</span>
        {onChange && (
          <button type="button" className="link-button" disabled={disabled} onClick={() => onChange({ ...finding, dismissed: false })}>
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
  return (
    <li className="finding">
      <div className="prose finding-brief">
        <Markdown text={finding.brief} sessionId={sessionId} />
      </div>
      <div className="finding-head">
        <span className="finding-mark">
          <span className={`finding-severity ${finding.blocking ? 'blocking' : finding.priority === 'low' ? 'suggestion' : 'attention'}`} title={`${PRIORITY_LABEL[finding.priority]} priority`}>
            {finding.blocking ? 'Blocking' : finding.priority === 'low' ? 'Suggestion' : 'Needs attention'}
          </span>
          {number !== undefined && <span className="finding-number">Finding {number}</span>}
        </span>
        {onChange && (
          <span className="finding-actions">
            <button type="button" className="link-button" disabled={disabled} onClick={() => setEditing(true)}>Edit</button>
            <button type="button" className="link-button" disabled={disabled} onClick={() => onChange({ ...finding, dismissed: true })}>Dismiss</button>
          </span>
        )}
      </div>
      {finding.fix && (
        <div className="finding-fix">
          <div className="finding-fix-label">Suggested fix</div>
          <div className="prose"><Markdown text={finding.fix} sessionId={sessionId} /></div>
        </div>
      )}
      {finding.detail && (
        <Fold label="Why this happens" startOpen={finding.blocking}>
          <div className="prose">
            <Markdown text={finding.detail} sessionId={sessionId} />
          </div>
        </Fold>
      )}
      {finding.refs.map((ref) => (
        <Fold key={`${ref.path}:${ref.line}`} label={
          <span className="finding-reference" title={`${ref.path}:${ref.line}`}>
            <span className="finding-reference-file">{ref.path.split('/').at(-1)}:{ref.line}</span>
            {ref.path.includes('/') && <span className="finding-reference-directory">{ref.path.slice(0, ref.path.lastIndexOf('/'))}</span>}
          </span>
        }>
          <ReviewCommentCode sessionId={sessionId} path={ref.path} line={ref.line} />
        </Fold>
      ))}
    </li>
  );
});
