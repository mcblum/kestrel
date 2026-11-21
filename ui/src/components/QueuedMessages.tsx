// Messages held for the agent's next turn, waiting just above the message box. Since 0.0.18 a message
// written while the agent works goes into its running turn at once and shows in the conversation; only
// the few it cannot take then are held here, and the strip says why (shared/mid-turn.ts). They are not
// part of the conversation until they are sent. The server keeps them (shared/queue.ts): they go when
// the running turn ends normally (or, held behind a card, once it is answered), and wait for
// "Send now" after a stop or a failure. Another session's messages (`ask_session`) wait here too, for the turn to end.
import { memo, useState } from 'react';
import { Pencil, X } from 'lucide-react';
import type { SessionQueue } from '@kestrel/server/model';
import { heldHint } from '@kestrel/server/mid-turn';
import { actions } from '../store.ts';
import { SentAttachments } from './attachments/SentAttachments.tsx';

interface Props {
  sessionId: string;
  queue: SessionQueue;
  /** A turn is running: held messages go when it ends (unless the queue is held). */
  running: boolean;
  /** A card above waits for an answer; nothing can be sent until it is answered. */
  waiting: boolean;
  /** Puts a removed message's text back into the message box. */
  onEdit: (text: string) => void;
}

export const QueuedMessages = memo(function QueuedMessages({ sessionId, queue, running, waiting, onEdit }: Props) {
  const [busy, setBusy] = useState(false);
  if (queue.items.length === 0) return null;
  const canSendNow = !running && !waiting;
  const sendNow = async () => {
    setBusy(true);
    await actions.sendQueued(sessionId);
    setBusy(false);
  };
  const edit = async (id: string, text: string) => {
    if (await actions.removeQueued(sessionId, id)) onEdit(text);
  };
  return (
    <div className="queued" role="group" aria-label="Held messages">
      {queue.items.map((m) => (
        <div key={m.id} className="queued-item">
          <span className="queued-tag">Held</span>
          <div className="queued-body">
            {m.text && <p className="queued-text">{m.text}</p>}
            {m.attachments && m.attachments.length > 0 && <SentAttachments sessionId={sessionId} attachments={m.attachments} small />}
          </div>
          {/* A message with files cannot go back to the box: its files are the session's now. Remove it instead. */}
          {!m.attachments?.length && (
            <button type="button" className="queued-icon" aria-label="Edit this held message" title="Edit (puts it back in the message box)" onClick={() => void edit(m.id, m.text)}>
              <Pencil aria-hidden />
            </button>
          )}
          <button type="button" className="queued-icon" aria-label="Take back this held message" title="Take it back" onClick={() => void actions.removeQueued(sessionId, m.id)}>
            <X aria-hidden />
          </button>
        </div>
      ))}
      <div className="queued-foot">
        <span>{heldHint(queue.items.find((m) => !m.fromAgent)?.why, running, queue.held, queue.items.length)}</span>
        {canSendNow && (
          <button type="button" className="secondary-button queued-send" disabled={busy} onClick={() => void sendNow()}>
            {busy ? 'Sending…' : 'Send now'}
          </button>
        )}
      </div>
    </div>
  );
});
