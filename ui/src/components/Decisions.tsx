// An agent waiting on you: an approval, a plan to accept, or questions to answer.
import { useState } from 'react';
import { Check } from 'lucide-react';
import type { CardQuestion, InputCard } from '@kestrel/server/model';
import { isAnsweredApproval } from '@kestrel/server/conversation-folds';
import { CardOptions } from './CardOptions.tsx';
import { ApprovalRun } from './ApprovalRun.tsx';
import { Markdown } from './Markdown.tsx';
import { SandboxOfferNote } from './SandboxAllowSetting.tsx';
import { actions } from '../store.ts';

type Answer = { optionId?: string; text?: string; answers?: Record<string, string>; confirmed?: true };
type Send = (answer: Answer) => void;

/**
 * An answered (or abandoned) question or plan: what was asked and what was chosen, as plain text.
 * A plan stays one click away. Answered approvals are one compact line instead (ApprovalRun.tsx).
 */
function Resolved({ card, sessionId }: { card: InputCard; sessionId: string }) {
  return (
    <div className="decision-box resolved">
      <strong>{card.title}</strong>
      <p className="resolved-answer">{card.resolved}</p>
      {card.markdown && card.detail && (
        <details className="plan-fold">
          <summary>Show plan</summary>
          <div className="plan-body prose">
            <Markdown text={card.detail} sessionId={sessionId} />
          </div>
        </details>
      )}
    </div>
  );
}

const PLAN_KICKER = 'Plan ready';

/** A plan to read and accept, rendered as markdown. */
function PlanCard({ card, sessionId, send }: { card: InputCard; sessionId: string; send: Send }) {
  // The card's title is usually the kicker again; a title that says something else still shows.
  const title = card.title && card.title.trim().toLowerCase() !== PLAN_KICKER.toLowerCase() ? card.title : null;
  return (
    <div className="decision-box plan-card" role="group" aria-label={card.title || PLAN_KICKER} data-pending-card>
      <strong>{PLAN_KICKER}</strong>
      {title && <p className="decision-title">{title}</p>}
      <div className="plan-body prose">
        <Markdown text={card.detail} sessionId={sessionId} />
      </div>
      <CardOptions card={card} onPick={(optionId, confirm) => send({ optionId, ...confirm })} />
    </div>
  );
}

/** A choice shown as a row: its label, what it means, and a mark when it is picked. */
function ChoiceRow({ label, description, picked, onClick }: { label: string; description?: string; picked?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`choice-row${picked ? ' picked' : ''}`} aria-pressed={picked === undefined ? undefined : picked} onClick={onClick}>
      {picked !== undefined && <span className="choice-mark">{picked && <Check aria-hidden />}</span>}
      <span className="choice-text">
        <span className="choice-label">{label}</span>
        {description && <span className="choice-desc">{description}</span>}
      </span>
    </button>
  );
}

/** One question with one answer: a click on a row answers it. Typing another answer is still possible. */
function SingleQuestion({ card, question, send }: { card: InputCard; question: CardQuestion; send: Send }) {
  const [text, setText] = useState('');
  const typed = () => text.trim() && send({ text: text.trim(), answers: { [question.question]: text.trim() } });
  return (
    <div className="decision-box" role="group" aria-label={card.title} data-pending-card>
      <strong>{question.header || 'Your call'}</strong>
      <p className="decision-title">{question.question}</p>
      <div className="choice-list">
        {question.options.map((o, i) => (
          <ChoiceRow key={o.label} label={o.label} description={o.description} onClick={() => send({ optionId: String(i), answers: { [question.question]: o.label } })} />
        ))}
      </div>
      <div className="decision-free">
        <input aria-label="Type another answer" placeholder="Or type another answer" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && typed()} />
      </div>
    </div>
  );
}

/** What one question has so far: the picked labels and a typed answer. */
interface Draft {
  picked: readonly string[];
  other: string;
}
const EMPTY: Draft = { picked: [], other: '' };

/** The answer a draft gives: the labels joined, with a typed answer taking the place of a single choice. */
function answerOf(q: CardQuestion, d: Draft): string {
  const other = d.other.trim();
  if (!q.multi) return other || d.picked[0] || '';
  return [...d.picked, ...(other ? [other] : [])].join(', ');
}

function pick(q: CardQuestion, d: Draft, label: string): Draft {
  if (!q.multi) return { picked: [label], other: '' };
  return { ...d, picked: d.picked.includes(label) ? d.picked.filter((l) => l !== label) : [...d.picked, label] };
}

/** One question inside a form: its rows behave like radio buttons or check boxes. */
function QuestionBlock({ q, draft, onChange, onEnter }: { q: CardQuestion; draft: Draft; onChange: (d: Draft) => void; onEnter: () => void }) {
  return (
    <div className="question-block" role="group" aria-label={q.question}>
      {q.header && <div className="question-header">{q.header}</div>}
      <p className="decision-title">{q.question}</p>
      {q.multi && <div className="question-hint">Pick any that apply</div>}
      <div className={`choice-list ${q.multi ? 'multi' : 'single'}`}>
        {q.options.map((o) => (
          <ChoiceRow key={o.label} label={o.label} description={o.description} picked={draft.picked.includes(o.label)} onClick={() => onChange(pick(q, draft, o.label))} />
        ))}
      </div>
      <input className="question-other" aria-label={`Other answer to: ${q.question}`} placeholder="Other…" value={draft.other} onChange={(e) => onChange(q.multi ? { ...draft, other: e.target.value } : { picked: [], other: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && onEnter()} />
    </div>
  );
}

/** Several questions, or any with several answers: pick, then submit once. */
function QuestionForm({ card, questions, send }: { card: InputCard; questions: readonly CardQuestion[]; send: Send }) {
  const [drafts, setDrafts] = useState<readonly Draft[]>(() => questions.map(() => EMPTY));
  const answers = questions.map((q, i) => answerOf(q, drafts[i] ?? EMPTY));
  const complete = answers.every((a) => a !== '');
  const submit = () => complete && send({ answers: Object.fromEntries(questions.map((q, i) => [q.question, answers[i]!])) });
  const change = (i: number, d: Draft) => setDrafts(drafts.map((old, j) => (j === i ? d : old)));
  return (
    <div className="decision-box question-form" role="group" aria-label={card.title} data-pending-card>
      <strong>{questions.length === 1 ? 'Your call' : `${questions.length} questions`}</strong>
      {questions.map((q, i) => (
        <QuestionBlock key={q.question} q={q} draft={drafts[i] ?? EMPTY} onChange={(d) => change(i, d)} onEnter={submit} />
      ))}
      <div className="decision-options explicit">
        <button className="primary" disabled={!complete} onClick={submit}>
          Submit
        </button>
      </div>
    </div>
  );
}

/** A card that is not a plan and has no structured questions: today's approval or question box. */
function PlainCard({ card, send }: { card: InputCard; send: Send }) {
  const [text, setText] = useState('');
  return (
    <div className="decision-box" role="group" aria-label={card.title} data-pending-card>
      <strong>{card.kind === 'approval' ? 'Approval needed' : 'Your call'}</strong>
      <p className="decision-title">{card.title}</p>
      {card.detail && <pre className="decision-detail">{card.detail}</pre>}
      <CardOptions card={card} variant="plain" onPick={(optionId, confirm) => send({ optionId, ...confirm })} />
      {card.sandboxOffer && <SandboxOfferNote />}
      {card.kind === 'question' && (
        <div className="decision-free">
          <input aria-label="Type another answer" placeholder="Or type another answer" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && text.trim() && send({ text: text.trim() })} />
        </div>
      )}
    </div>
  );
}

/** Picks the card's shape: resolved, plan, one simple question, a question form, or plain. */
export function InputCardView({ card, sessionId }: { card: InputCard; sessionId: string }) {
  const send: Send = (answer) => void actions.answer(sessionId, card.id, answer);
  if (isAnsweredApproval(card)) return <ApprovalRun cards={[card]} />;
  if (card.resolved) return <Resolved card={card} sessionId={sessionId} />;
  if (card.markdown) return <PlanCard card={card} sessionId={sessionId} send={send} />;
  const questions = card.questions ?? [];
  if (questions.length === 1 && !questions[0]!.multi) return <SingleQuestion card={card} question={questions[0]!} send={send} />;
  if (questions.length > 0) return <QuestionForm card={card} questions={questions} send={send} />;
  return <PlainCard card={card} send={send} />;
}
