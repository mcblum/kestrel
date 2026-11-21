// Optional actions the agent dropped in (shared/suggestions.ts). The open one is a small card at the
// foot of the conversation, just above the message box, in the same stack as queued messages: its
// title, the reason in quiet text, and its buttons (the primary first). The small x is the kind's
// "not now". Newer ones wait behind it ("+1"). Nothing here takes focus: the message box keeps it.
// Once answered or dismissed, the card goes and one quiet line stays where it was raised, with Undo
// where the kind offers it. Any kind is drawn the same way: the server owns titles, buttons and lines.
import { memo, useMemo, useState } from 'react';
import { Lightbulb, X } from 'lucide-react';
import type { ChatMessage } from '@kestrel/server/model';
import { orderedButtons, shownSuggestion, type Suggestion } from '@kestrel/server/suggestions';
import { suggestionActions } from '../suggestionsApi.ts';

function Card({ sessionId, suggestion, waiting }: { sessionId: string; suggestion: Suggestion; waiting: number }) {
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    await work();
    setBusy(false);
  };
  return (
    <div className="suggestion-card" role="group" aria-label={`Suggestion: ${suggestion.title}`}>
      <div className="suggestion-head">
        <Lightbulb className="suggestion-icon" aria-hidden />
        <span className="suggestion-title">{suggestion.title}</span>
        {waiting > 0 && (
          <span className="suggestion-more" title={`${waiting} more ${waiting === 1 ? 'suggestion waits' : 'suggestions wait'} behind this one`}>
            +{waiting}
          </span>
        )}
        <button type="button" className="suggestion-x" aria-label="Not now" title="Not now" disabled={busy} onClick={() => void run(() => suggestionActions.dismiss(sessionId, suggestion.id))}>
          <X aria-hidden />
        </button>
      </div>
      {suggestion.reason && <p className="suggestion-reason">{suggestion.reason}</p>}
      <div className="suggestion-buttons">
        {orderedButtons(suggestion.buttons).map((b) => (
          <button key={b.id} type="button" className={b.primary ? 'suggestion-primary' : 'suggestion-quiet'} disabled={busy} onClick={() => void run(() => suggestionActions.answer(sessionId, suggestion.id, b.id))}>
            {b.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The open suggestion of a session, above the message box; nothing when there is none (or the server is older). */
export const SuggestionDock = memo(function SuggestionDock({ sessionId, messages }: { sessionId: string; messages: readonly ChatMessage[] | undefined }) {
  const shown = useMemo(() => shownSuggestion(messages), [messages]);
  if (!shown) return null;
  return <Card key={shown.suggestion.id} sessionId={sessionId} suggestion={shown.suggestion} waiting={shown.waiting} />;
});

/** What an answered suggestion leaves in the conversation: one quiet line, with Undo when offered. */
export const SuggestionLine = memo(function SuggestionLine({ sessionId, suggestion }: { sessionId: string; suggestion: Suggestion }) {
  const [busy, setBusy] = useState(false);
  if (suggestion.state === 'open' || !suggestion.line) return null;
  const undo = async () => {
    setBusy(true);
    await suggestionActions.undo(sessionId, suggestion.id);
    setBusy(false);
  };
  return (
    <div className="suggestion-line" role="note">
      <Lightbulb aria-hidden />
      <span>{suggestion.line}</span>
      {suggestion.undo && (
        <button type="button" className="suggestion-undo" disabled={busy} onClick={() => void undo()}>
          Undo
        </button>
      )}
    </div>
  );
});
