// Settings → Tickets → Changes to tickets: the standing answers the user gave a session's proposal to
// change its ticket (Allow always, Don't ask again), one row per kind of change and tracker, each set
// back to Ask from its select. Selects save as they are changed. The answers are a route answer held
// once in the store (`useResource`), asked again after a change.
import { ready, type Sourced } from '@kestrel/server/sourced';
import { ANSWER_SOURCE_LABEL, asTicketAnswers, TICKET_CHANGE_LABEL, type StandingAnswer, type TicketAnswer } from '@kestrel/server/ticket-changes';
import { useResource } from '../data/resources.ts';
import { OLDER_SERVER, RESTART_REASON } from '../store.ts';
import { setTicketAnswer, TICKET_ANSWERS_PATH } from '../suggestionsApi.ts';
import { SettingSection } from './SettingHelp.tsx';

const asAnswers = (raw: unknown): Sourced<TicketAnswer[]> => ready(asTicketAnswers((raw as { answers?: unknown } | null)?.answers));

const HELP = (
  <p className="settings-help">
    A session may propose moving its ticket to In progress or In review, or adding a comment. Kestrel asks on a card that never holds the work up. What you answer with Allow always or Don’t ask again is kept per kind of change and tracker, and listed here.
  </p>
);

function AnswerRow({ answer, changed }: { answer: TicketAnswer; changed: () => void }) {
  const id = `ticket-answer-${answer.source}-${answer.change}`;
  const pick = async (value: StandingAnswer | 'ask') => {
    await setTicketAnswer(answer.change, answer.source, value);
    changed();
  };
  return (
    <div className="ticket-answer">
      <label htmlFor={id}>
        {ANSWER_SOURCE_LABEL[answer.source]} · {TICKET_CHANGE_LABEL[answer.change]}
      </label>
      <select id={id} className="form-control" value={answer.answer} onChange={(e) => void pick(e.target.value as StandingAnswer | 'ask')}>
        <option value="ask">Ask</option>
        <option value="always">Allow always</option>
        <option value="never">Don’t ask</option>
      </select>
    </div>
  );
}

/** The standing answers to ticket changes, each settable back to Ask. */
export function TicketAnswersSetting() {
  const { value, refresh } = useResource(TICKET_ANSWERS_PATH, asAnswers);
  const changed = () => void refresh();
  return (
    <SettingSection title="Changes to tickets" help={HELP}>
      {value.state !== 'ready' ? (
        <p className="settings-help">{value.state === 'loading' ? 'Loading…' : value.reason === RESTART_REASON ? OLDER_SERVER : value.reason}</p>
      ) : value.value.length === 0 ? (
        <p className="settings-help">Kestrel asks before every change. Nothing is answered for good yet.</p>
      ) : (
        value.value.map((a) => <AnswerRow key={`${a.source}:${a.change}`} answer={a} changed={changed} />)
      )}
    </SettingSection>
  );
}
