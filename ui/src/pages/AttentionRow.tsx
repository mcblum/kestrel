// A row in the "Needs you" queue: the actual question or blocker. An approval is answered right
// here with the card's own options (ApprovalDecision.tsx), with "View in chat" beside it; anything
// else (a question, a plan to review, a failure) has one action that opens the session at that
// card. The question comes from the session's detail, fetched once and cached. A session listed only
// because its pull request needs the user (failed checks, conflicts, requested changes:
// @kestrel/server/request-attention) says
// so instead, with the request's mark in red and a cross, and needs no detail.
import { memo, useEffect, useRef } from 'react';
import { ArrowUpRight, GitPullRequest, X } from 'lucide-react';
import { attentionLine, type RequestAttention } from '@kestrel/server/request-attention';
import type { SessionView, WorkspaceState } from '@kestrel/server/model';
import { statusOf } from '@kestrel/server/status';
import { age, AGENT_LABEL, filingMark, projectName } from '../labels.ts';
import { FilingTag } from '../components/FilingTag.tsx';
import { opener, openSession } from '../route.ts';
import { actions, focusRequests, useApp } from '../store.ts';
import { ApprovalDecision } from './ApprovalDecision.tsx';

const firstLine = (text: string, max = 160) => {
  const line = (text.split('\n').find((l) => l.trim()) ?? '').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

interface Props {
  session: SessionView;
  workspace: WorkspaceState;
  /** What its pull request needs of the user; null when nothing. */
  attention?: RequestAttention | null;
}

export const AttentionRow = memo(function AttentionRow({ session, workspace, attention = null }: Props) {
  const status = statusOf(session);
  // Listed for its pull request alone: the session itself waits on nothing.
  const forRequest = attention !== null && status !== 'needs-you' && status !== 'failed';
  const fetched = useApp((s) => s.details.get(session.id));
  useEffect(() => void (forRequest ? undefined : actions.loadDetail(session.id)), [session, forRequest]);
  // The cached detail is dropped (and fetched again) whenever the session changes. Keep showing the
  // last one meanwhile, so an approval being answered here keeps its state instead of flickering away.
  const last = useRef(fetched);
  if (fetched) last.current = fetched;
  const detail = fetched ?? last.current;
  const card = detail?.messages.findLast((m) => m.input && !m.input.resolved)?.input;
  const asked = detail?.messages.findLast((m) => m.question)?.question;
  const failed = status === 'failed';
  // A plain approval (a command, an edit) is decided on the row; a plan with long markdown is reviewed in the chat.
  const approval = !failed && card?.kind === 'approval' && !card.markdown ? card : null;

  const reason = failed ? session.note.replace(/^Failed\s*·\s*/, '') : card ? (card.kind === 'question' ? card.detail : card.title) : (asked?.text ?? session.note.replace(/^Needs you\s*·\s*/, ''));
  // A plan's first line hints at it; the whole plan is read in the chat.
  const planLine = !failed && card?.kind === 'approval' && card.markdown ? firstLine(card.detail) : '';
  const action = approval ? 'View in chat' : failed ? 'See why' : card?.kind === 'question' || asked ? 'Answer' : card ? 'Review' : 'Open';
  const mark = filingMark(session.filing.status, session.filing.discarded);

  const open = (newTab: boolean) => {
    focusRequests.add(session.id);
    openSession(session.id, newTab);
  };
  const top = (
    <span className="qrow-top">
      <strong className="inbox-title">{session.title}</strong>
      <span className="qrow-meta">
        {projectName(session, workspace.projects)}
        <FilingTag mark={mark} /> · {AGENT_LABEL[session.agent]} · {age(session.updatedAt)}
      </span>
    </span>
  );
  const why = forRequest ? (
    <span className="qrow-reason">
      <span className="qrow-request pr-tone-red" aria-hidden>
        <GitPullRequest />
        <X className="qrow-request-alert" />
      </span>
      {attentionLine(attention)}
    </span>
  ) : (
    <span className="qrow-reason">
      <span className="status-dot amber" />
      {reason}
    </span>
  );
  return (
    <div className={`qrow${approval ? ' qrow-approval' : ''}`}>
      {approval ? (
        // Buttons cannot sit inside the row's own button, so here the title is the link to the session.
        <div className="qrow-main">
          <button type="button" className="qrow-open" {...opener(open)}>
            {top}
            {why}
          </button>
          <ApprovalDecision sessionId={session.id} card={approval} />
        </div>
      ) : (
        <button type="button" className="qrow-main" {...opener(open)}>
          {top}
          {why}
          {planLine && <code className="qrow-detail">{planLine}</code>}
        </button>
      )}
      <button type="button" className="secondary-button small qrow-action" {...opener(open)}>
        {action} <ArrowUpRight aria-hidden />
      </button>
    </div>
  );
});
