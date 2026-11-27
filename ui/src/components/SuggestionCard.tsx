// Optional actions the agent dropped in (shared/suggestions.ts). The open one is a small card at the
// foot of the conversation, just above the message box, in the same stack as queued messages: its
// title, the reason in quiet text, and its buttons (the primary first). The small x is the kind's
// "not now". Newer ones wait behind it ("+1"). Nothing here takes focus: the message box keeps it.
// Once answered or dismissed, the card goes and one quiet line stays where it was raised, with Undo
// where the kind offers it. Any kind is drawn the same way: the server owns titles, buttons and lines.
// A card with `picks` (a tag card) also draws the names to choose (SuggestionPicks.tsx) and sends what
// is chosen with the buttons that take it. A card about a pull request the store already holds as merged
// or closed is not drawn (shared/request-cards.ts); the server withdraws it.
import { memo, useMemo, useState } from 'react';
import { Lightbulb, X } from 'lucide-react';
import type { ChatMessage } from '@kestrel/server/model';
import { orderedButtons, shownSuggestion, type Suggestion } from '@kestrel/server/suggestions';
import { cardSession, requestCardGone } from '@kestrel/server/request-cards';
import { useApp } from '../store.ts';
import { withTyped } from '@kestrel/server/tag-match';
import { useKnownTags } from './SessionTags.tsx';
import { SuggestionPicks } from './SuggestionPicks.tsx';
import { openSession } from '../route.ts';
import { Markdown } from './Markdown.tsx';
import { suggestionActions } from '../suggestionsApi.ts';

function Card({ sessionId, suggestion, waiting }: { sessionId: string; suggestion: Suggestion; waiting: number }) {
  const [busy, setBusy] = useState(false);
  // Each button's checkbox, by button id: as the server set it until the user changes it.
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  // What is chosen on a card with names to choose, and the text not yet made a chip: a draft, sent with the answer.
  const picks = suggestion.picks;
  const known = useKnownTags();
  // `untouched` until the user changes the choice in any way (a chip, a typed name, a removal).
  const [choice, setChoice] = useState<{ chosen: readonly string[]; untouched: boolean }>({ chosen: picks?.chosen ?? [], untouched: true });
  const chosen = choice.chosen;
  const setChosen = (next: readonly string[]) => setChoice((was) => (next === was.chosen ? was : { chosen: next, untouched: false }));
  const [typing, setTyping] = useState('');
  /** What a button that takes the choice sends: the chips, and what was typed without Enter. */
  const picked = (button: string): readonly string[] | undefined => (picks?.buttons.includes(button) ? withTyped(chosen, typing, known) : undefined);
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
      {/* What would be sent, whole (a ticket comment): read before it is allowed. */}
      {suggestion.detail && (
        <div className="suggestion-detail prose" role="group" aria-label="What would be sent" tabIndex={0}>
          <Markdown text={suggestion.detail} sessionId={sessionId} />
        </div>
      )}
      {picks && <SuggestionPicks picks={picks} known={known} chosen={chosen} untouched={choice.untouched} typing={typing} disabled={busy} onChosen={setChosen} onTyping={setTyping} />}
      <div className="suggestion-buttons">
        {orderedButtons(suggestion.buttons)
          .filter((b) => !b.folded)
          .map((b) => {
            const on = b.toggle ? (ticked[b.id] ?? b.toggle.checked) : false;
            const sends = b.toggle && on ? b.toggle.id : b.id;
            const picksSent = picked(sends);
            return (
              <span key={b.id} className="suggestion-button-group">
                <button type="button" className={b.primary ? 'suggestion-primary' : 'suggestion-quiet'} disabled={busy || picksSent?.length === 0} title={picksSent?.length === 0 ? 'Choose a tag first' : undefined} onClick={() => void run(() => suggestionActions.answer(sessionId, suggestion.id, sends, picksSent))}>
                  {b.label}
                </button>
                {b.toggle && (
                  <label className="suggestion-toggle">
                    <input type="checkbox" checked={on} disabled={busy} onChange={(e) => setTicked((t) => ({ ...t, [b.id]: e.target.checked }))} />
                    {b.toggle.label}
                  </label>
                )}
              </span>
            );
          })}
      </div>
    </div>
  );
}

/** The open suggestion of a session, above the message box; nothing when there is none (or the server is older). */
export const SuggestionDock = memo(function SuggestionDock({ sessionId, messages }: { sessionId: string; messages: readonly ChatMessage[] | undefined }) {
  const pullRequests = useApp((s) => s.pullRequests);
  const shown = useMemo(() => shownSuggestion(messages, (s) => requestCardGone(s, pullRequests.get(cardSession(s))) === null), [messages, pullRequests]);
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
      {suggestion.opens && (
        <button type="button" className="suggestion-undo" onClick={(e) => openSession(suggestion.opens!, e.metaKey || e.ctrlKey)}>
          Open it
        </button>
      )}
      {suggestion.link && /^https?:\/\//.test(suggestion.link) && (
        <a className="suggestion-undo" href={suggestion.link} target="_blank" rel="noreferrer">
          Open it
        </a>
      )}
      {suggestion.undo && (
        <button type="button" className="suggestion-undo" disabled={busy} onClick={() => void undo()}>
          Undo
        </button>
      )}
    </div>
  );
});
