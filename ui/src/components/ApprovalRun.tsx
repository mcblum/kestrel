// Approvals you have already answered, as one quiet line ("12 commands allowed", "9 commands
// allowed · 1 denied") that opens to list each: what was asked, and the outcome as plain text. A
// denial or an approval nobody answered keeps its meaning colour in the closed line. The rule for
// which cards join one line is in @kestrel/server/conversation-folds.
import { memo } from 'react';
import { Ban, Check, X } from 'lucide-react';
import type { InputCard } from '@kestrel/server/model';
import { askedLine, outcomeOf, outcomeText, summarizeApprovals } from '@kestrel/server/conversation-folds';

function ApprovalItem({ card }: { card: InputCard }) {
  const line = askedLine(card);
  const full = card.detail.trim();
  const outcome = outcomeOf(card);
  const row = (
    <>
      <span className="approval-asked" title={line}>
        {line}
      </span>
      <span className={`approval-outcome outcome-${outcome}`}>{outcomeText(card)}</span>
    </>
  );
  // Only a row with more to read than its one line opens.
  if (!full || full === line) return <li className="approval-row">{row}</li>;
  return (
    <li>
      <details className="approval-more">
        <summary className="approval-row">{row}</summary>
        <pre className="approval-detail">{full}</pre>
      </details>
    </li>
  );
}

export const ApprovalRun = memo(
  function ApprovalRun({ cards }: { cards: readonly InputCard[] }) {
    const summary = summarizeApprovals(cards);
    const Icon = summary.denied ? X : summary.other ? Ban : Check;
    const mark = summary.denied ? 'outcome-denied' : summary.other ? 'outcome-other' : '';
    return (
      <details className="tool-activity approval-run">
        <summary aria-label={`${summary.text}. Show each`}>
          <Icon aria-hidden className={mark} />
          <span className="step-summary">
            {summary.parts.map((p, i) => (
              <span key={p.outcome} className={p.outcome === 'allowed' ? '' : `outcome-${p.outcome}`}>
                {i > 0 && ' · '}
                {p.text}
              </span>
            ))}
          </span>
        </summary>
        <ul className="approval-list">
          {cards.map((card) => (
            <ApprovalItem key={card.id} card={card} />
          ))}
        </ul>
      </details>
    );
  },
  // A new list with the same cards (unchanged objects) does not redraw the line.
  (a, b) => a.cards.length === b.cards.length && a.cards.every((c, i) => c === b.cards[i]),
);
