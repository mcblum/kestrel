// One row of the conversation (@kestrel/server/conversation-rows): a message or the fold that
// starts at it, the footer of a turn that ends there, and the sub-agent card when it sits under it.
// Memoized on the row object, which keeps its identity while it draws the same thing, so text
// streaming into one message draws that row again and no other.
import { memo, useMemo, type ReactNode } from 'react';
import type { ChatActivity, InputCard } from '@kestrel/server/model';
import type { ConversationRow, FoldRow } from '@kestrel/server/conversation-rows';
import { Message, Steps } from './Conversation.tsx';
import { PictureGroup } from './PictureGroup.tsx';
import { Pictures } from './Pictures.tsx';
import { ApprovalRun } from './ApprovalRun.tsx';
import { pictureCaption } from './pictureCaptions.ts';
import { TurnFoot, type ForkContext } from './TurnFoot.tsx';

/** A folded stretch: one strip of its pictures, one line for its approvals, one for its steps. */
const FoldAt = memo(function FoldAt({ row, sessionId }: { row: FoldRow; sessionId: string }) {
  const { fold, reads, from } = row;
  const at = (index: number) => reads[index - from];
  const images = useMemo(() => fold.pictures.map((p) => p.name), [fold]);
  const captions = useMemo(() => fold.pictures.map((p) => pictureCaption(reads, p.message - from)), [fold, reads, from]);
  const cards = useMemo(() => fold.approvals.map((i) => at(i)!.input as InputCard), [fold, reads, from]);
  // The tool lines of the text just before the fold (its lead) come first: they ran first.
  const steps = useMemo(() => [...(fold.lead === undefined ? [] : [fold.lead]), ...fold.steps].flatMap((i) => (at(i)?.activity ?? []) as ChatActivity[]), [fold, reads, from]);
  return (
    <div className="chat-message theirs chat-fold">
      {images.length === 1 && <Pictures sessionId={sessionId} images={images} caption={captions[0]} />}
      {images.length > 1 && <PictureGroup sessionId={sessionId} images={images} captions={captions} />}
      {cards.length > 0 && <ApprovalRun cards={cards} />}
      {steps.length > 0 && <Steps activity={steps} sessionId={sessionId} />}
    </div>
  );
});

interface RowProps {
  row: ConversationRow;
  sessionId: string;
  onChoice: (choice: string) => void;
  onReply: (text: string) => void;
  onReuse: (text: string) => void;
  /** The sub-agent card, given only to the row it sits under. */
  anchored: ReactNode;
  /** What a finished turn's Fork needs of the session (the same object for every row). */
  fork?: ForkContext;
}

export const RowView = memo(function RowView({ row, sessionId, onChoice, onReply, onReuse, anchored, fork }: RowProps) {
  const footer = row.footer;
  return (
    <>
      {row.kind === 'fold' && <FoldAt row={row} sessionId={sessionId} />}
      {row.kind === 'message' && <Message message={row.message} sessionId={sessionId} onChoice={onChoice} onReply={onReply} onReuse={onReuse} withoutSteps={row.textOnly} />}
      {footer && <TurnFoot copyKey={`turn:${sessionId}:${row.key}`} markdown={footer.markdown} startedAt={footer.timing?.startedAt} endedAt={footer.timing?.endedAt} fork={fork} turn={footer.fork} {...(row.key.startsWith('at-') ? {} : { pointId: row.key })} />}
      {row.anchored && anchored}
    </>
  );
});
