// What sits just above a session's message box, top to bottom: the work the agent left running in
// the background (BackgroundTasks.tsx), right under the conversation's live status line, then the
// card left when a review of this work ended with findings open (ReviewEndCard.tsx), then the
// open optional action the agent suggested (SuggestionCard.tsx), then the messages held for the
// agent's next turn (QueuedMessages.tsx); a message written while it works goes into its turn instead.
import type { ChatMessage, SessionQueue } from '@kestrel/server/model';
import { BackgroundTasks } from './BackgroundTasks.tsx';
import { QueuedMessages } from './QueuedMessages.tsx';
import { SuggestionDock } from './SuggestionCard.tsx';
import { ReviewEndDock } from './ReviewEndCard.tsx';

interface Props {
  sessionId: string;
  messages: readonly ChatMessage[] | undefined;
  queue: SessionQueue;
  running: boolean;
  waiting: boolean;
  onEdit: (text: string) => void;
  /** Open the Commands pane on one command (a row of the background strip). */
  onOpenCommand: (commandId: string) => void;
}

export function ComposerFoot({ sessionId, messages, queue, running, waiting, onEdit, onOpenCommand }: Props) {
  return (
    <>
      <BackgroundTasks sessionId={sessionId} onOpenCommand={onOpenCommand} />
      <ReviewEndDock sessionId={sessionId} messages={messages} />
      <SuggestionDock sessionId={sessionId} messages={messages} />
      <QueuedMessages sessionId={sessionId} queue={queue} running={running} waiting={waiting} onEdit={onEdit} />
    </>
  );
}
