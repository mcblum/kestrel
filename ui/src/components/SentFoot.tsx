// The quiet line under one of the user's own messages: when it was sent (and, for one sent into a
// running turn, whether the agent has read it yet), a copy button, and a button that puts the text
// back in the message box to edit and send again. The same look as the
// line under a finished turn (TurnFoot), on the right, under the bubble.
import { memo } from 'react';
import { RotateCcw } from 'lucide-react';
import { finishedText } from '@kestrel/server/when';
import { midTurnLabel, type MidTurnState } from '@kestrel/server/mid-turn';
import { CopyButton } from './CopyButton.tsx';

interface Props {
  text: string;
  /** Absent on messages stored before sending was timed: then no time is shown. */
  sentAt?: number;
  /** Sent into a running turn: how far it got (shared/mid-turn.ts). */
  midTurn?: MidTurnState;
  /** No button without it: nothing here is clickable that cannot do anything. */
  onReuse?: (text: string) => void;
}

export const SentFoot = memo(function SentFoot({ text, sentAt, midTurn, onReuse }: Props) {
  return (
    <div className="turn-foot sent-foot">
      {midTurn && <span className={`mid-turn mid-turn-${midTurn}`}>{midTurnLabel(midTurn)}</span>}
      {sentAt !== undefined && <span className="turn-time">{finishedText(sentAt, Date.now())}</span>}
      <CopyButton value={text} label="message" />
      {onReuse && (
        <button type="button" className="copy-button" aria-label="Edit and send again" title="Edit and send again" onClick={() => onReuse(text)}>
          <RotateCcw aria-hidden />
        </button>
      )}
    </div>
  );
});
