// An approval answered from a Needs you row: exactly what would run, readable in full, and the
// card's own options. The answer goes to the same endpoint as the card in the conversation; while
// it is on its way the buttons wait, and a refusal shows here, on the row.
import { useEffect, useState } from 'react';
import type { InputCard } from '@kestrel/server/model';
import { CardOptions } from '../components/CardOptions.tsx';
import { actions } from '../store.ts';

/** Longer than this (in lines or characters) folds, with a control to show all of it. */
const FOLD_LINES = 6;
const FOLD_CHARS = 480;

function CommandDetail({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.split('\n').length > FOLD_LINES || text.length > FOLD_CHARS;
  if (!text.trim()) return null;
  return (
    <div className="qrow-command-wrap">
      <pre className={`qrow-command${long && !open ? ' folded' : ''}`}>{text}</pre>
      {long && (
        <button type="button" className="qrow-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}

export function ApprovalDecision({ sessionId, card }: { sessionId: string; card: InputCard }) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Another card (or the same one answered elsewhere): start clean.
  useEffect(() => {
    setPending(null);
    setError(null);
  }, [card.id]);

  const pick = async (optionId: string) => {
    setPending(optionId);
    setError(null);
    const refused = await actions.answerHere(sessionId, card.id, { optionId });
    // The row leaves the list when the session runs again; with another card still waiting it
    // stays, so fetch the conversation again to show that one.
    actions.loadDetail(sessionId, true);
    setPending(null);
    if (refused) setError(refused);
  };

  return (
    <div className="qrow-decide">
      <CommandDetail text={card.detail} />
      <CardOptions card={card} onPick={(id) => void pick(id)} pendingId={pending} />
      {error && (
        <p className="qrow-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
