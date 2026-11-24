import { openFrom } from './controls/anchor.ts';
import { stepNote, stepsNote, stepsSummary } from '@kestrel/server/steps-summary';
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, Check, CornerDownLeft, FileDiff, Info, Split, Square, Terminal, TriangleAlert, X } from 'lucide-react';
import type { ChatActivity, ChatMessage } from '@kestrel/server/model';
import { Markdown } from './Markdown.tsx';
import { SentFoot } from './SentFoot.tsx';
import { UserText } from './UserText.tsx';
import { InputCardView } from './Decisions.tsx';
import { FileCardView, NextStepBox, TodoCard } from './Cards.tsx';
import { ReviewReplyCard } from './ReviewReplyCard.tsx';
import { RoundFindingsCard } from './RoundFindingsCard.tsx';
import { ReviewEndLine } from './ReviewEndCard.tsx';
import { StartedHere } from './Lineage.tsx';
import { WidgetView } from './Widget.tsx';
import { Pictures } from './Pictures.tsx';
import { SuggestionLine } from './SuggestionCard.tsx';
import { SignInOffer } from './SignIn.tsx';
import { drafts, type AttachmentRefs } from '../store.ts';
import { SentAttachments } from './attachments/SentAttachments.tsx';
import { useAttachments } from './attachments/useAttachments.tsx';
import { MessageInput, type MessageInputHandle } from './MessageInput.tsx';
import { useSlashMenu } from './useSlashMenu.tsx';
import type { SlashCommand } from '@kestrel/server/slash-commands';

import { focusChange } from '../changesFocus.ts';

const ACTIVITY_ICON = { check: Check, 'file-diff': FileDiff, terminal: Terminal, split: Split, 'arrow-right': ArrowRight } as const;

/** The tools a message used, folded to one line once they have all finished. */
/**
 * One tool line. An edit that names its files opens the Changes pane at the first one's diff. When
 * Kestrel refused the step, or let it through though it would have refused it, the reason is shown
 * under the line as text (shared/steps-summary.ts `stepNote`), not only as a tooltip.
 */
function StepLine({ step, sessionId }: { step: ChatActivity; sessionId?: string }) {
  const note = stepNote(step);
  const warned = note?.kind === 'warning';
  // Only a finished step may wear its own icon (which can be a tick): a failed one is an X, a stopped one the stop square, a warned one the warning sign.
  const Icon = step.status === 'failed' ? X : step.status === 'stopped' ? Square : warned ? TriangleAlert : ACTIVITY_ICON[step.icon];
  const path = step.status !== 'failed' && sessionId ? step.paths?.[0] : undefined;
  const state = warned ? 'activity-warning' : step.status ? `activity-${step.status}` : '';
  return (
    <span className={`step-line ${state}`} title={note ? undefined : step.detail}>
      <span className="step-head">
        <Icon aria-hidden />
        {path && sessionId ? (
          <button type="button" className="step-file" title={`Show the diff of ${path}`} onClick={() => focusChange(sessionId, path)}>
            {step.text}
          </button>
        ) : (
          step.text
        )}
      </span>
      {note && <span className="step-reason">{note.text}</span>}
    </span>
  );
}

type StepsEnd = 'running' | 'failed' | 'stopped' | 'warning' | 'done';

/** How a series of steps stands, for its folded line: the tick only when every step finished and none went through that Kestrel would have refused. */
function stepsEnd(activity: readonly ChatActivity[]): StepsEnd {
  if (activity.some((a) => a.status === 'running')) return 'running';
  if (activity.some((a) => a.status === 'failed')) return 'failed';
  if (activity.some((a) => a.status === 'stopped')) return 'stopped';
  return activity.some((a) => a.warning) ? 'warning' : 'done';
}

const END_MARK: Record<StepsEnd, ReactNode> = {
  running: <span className="working-pulse" aria-hidden />,
  failed: <X aria-hidden />,
  stopped: <Square aria-label="Stopped before it finished" />,
  warning: <TriangleAlert aria-label="Made, though Kestrel would have refused it" />,
  done: <Check aria-hidden />,
};

export function Steps({ activity, sessionId }: { activity: ChatActivity[]; /** Lets an edit line open its diff. */ sessionId?: string }) {
  const end = stepsEnd(activity);
  const last = activity.at(-1)!;
  // While it runs: what it is doing now. Afterwards: what was done (shared/steps-summary), never a bare count.
  const summary = end === 'running' ? last.text : stepsSummary(activity);
  // A Kestrel refusal or warning shows one line of its reason on the folded row, so it is seen without opening it.
  const note = end === 'running' ? null : stepsNote(activity);
  return (
    <details className="tool-activity">
      <summary className={`${end === 'failed' || end === 'stopped' || end === 'warning' ? `activity-${end}` : ''}${note ? ' with-note' : ''}`}>
        {END_MARK[end]}
        <span className="step-summary">{summary}</span>
        {note && <span className="step-note">{note.line}</span>}
      </summary>
      <div className="step-list">
        {activity.map((a, i) => (
          <StepLine key={a.id ?? i} step={a} sessionId={sessionId} />
        ))}
      </div>
    </details>
  );
}

/** Whether an agent message has anything to show. A turn where it only thought leaves nothing. */
function hasContent(m: ChatMessage): boolean {
  return Boolean(m.text || m.activity?.length || m.input || m.question || m.todos?.length || m.widget || m.file || m.review || m.roundFindings || m.next || m.started || m.images?.length);
}

interface MessageProps {
  message: ChatMessage;
  sessionId: string;
  /** Puts a suggested answer in the composer to edit. */
  onChoice: (choice: string) => void;
  /** Sends a reply now (a next-step button, or a widget's sendPrompt). */
  onReply: (text: string) => void;
  /** Put a sent message back in the message box to edit. Absent where there is no box (a folded group). */
  onReuse?: (text: string) => void;
  /** Its tool lines are drawn in the fold that follows it (shared/conversation-folds.ts, `lead`). */
  withoutSteps?: boolean;
}

/** One message. Yours sit on the right in a bubble; the agent's run down the left, unlabelled. */
export const Message = memo(function Message({ message, sessionId, onChoice, onReply, onReuse, withoutSteps }: MessageProps) {
  const mine = message.author === 'you';
  const source = useMemo(() => (message.id ? { sessionId, messageId: message.id } : undefined), [sessionId, message.id]);
  // Start warnings stored by earlier builds; they now go to the agent output log instead.
  if (message.notice === 'warning' && message.id?.startsWith('warning-')) return null;
  if (message.notice)
    return (
      <div className={`chat-message chat-error${message.notice === 'warning' ? ' chat-warning' : ''}${message.notice === 'info' ? ' chat-info' : ''}`} role={message.notice === 'info' ? 'note' : 'alert'}>
        {message.notice === 'info' ? <Info aria-hidden /> : <TriangleAlert aria-hidden />}{' '}
        {message.signIn ? (
          <div className="chat-error-body">
            {message.text}
            <SignInOffer sessionId={sessionId} />
          </div>
        ) : (
          message.text
        )}
      </div>
    );
  if (message.suggestion) return <SuggestionLine sessionId={sessionId} suggestion={message.suggestion} />;
  if (message.reviewEnd && message.id) return <ReviewEndLine sessionId={sessionId} cardId={message.id} end={message.reviewEnd} />;
  if (!mine && !hasContent(message)) return null;
  return (
    <div className={`chat-message ${mine ? 'mine' : 'theirs'}`}>
      {mine && message.attachments && message.attachments.length > 0 && <SentAttachments sessionId={sessionId} attachments={message.attachments} />}
      {message.text &&
        (mine ? (
          <>
            <UserText text={message.text} source={source} />
            <SentFoot text={message.text} sentAt={message.sentAt} midTurn={message.midTurn} onReuse={onReuse} />
          </>
        ) : (
          // The streaming caret is drawn by CSS at the end of the last line of text (.streaming, app.css):
          // an element after the markdown would sit on a line of its own and move everything when it goes.
          <div className={`chat-text prose${message.streaming ? ' streaming' : ''}`}>
            <Markdown text={message.text} sessionId={sessionId} messageId={message.id} />
          </div>
        ))}
      {!withoutSteps && message.activity && message.activity.length > 0 && <Steps activity={message.activity} sessionId={sessionId} />}
      {message.todos && message.todos.length > 0 && <TodoCard todos={message.todos} />}
      {message.images && message.images.length > 0 && <Pictures sessionId={sessionId} images={message.images} />}
      {message.widget && <WidgetView widget={message.widget} onPrompt={onReply} />}
      {message.file && <FileCardView file={message.file} sessionId={sessionId} />}
      {message.review && message.id && <ReviewReplyCard review={message.review} sessionId={sessionId} cardId={message.id} />}
      {message.roundFindings && message.id && <RoundFindingsCard round={message.roundFindings} sessionId={sessionId} cardId={message.id} />}
      {message.input && <InputCardView card={message.input} sessionId={sessionId} />}
      {message.question && (
        <div className="decision-box">
          <strong>Your call</strong>
          <p>{message.question.text}</p>
          <div className="decision-options">
            {message.question.choices.map((choice) => (
              <button key={choice} onClick={() => onChoice(choice)}>
                {choice}
              </button>
            ))}
          </div>
        </div>
      )}
      {message.started && <StartedHere started={message.started} />}
      {message.next && <NextStepBox next={message.next} sessionId={sessionId} onReply={onReply} />}
    </div>
  );
});

/** A suggested reply chosen in the conversation, to be placed in the composer for editing. */
export interface Inject {
  id: string;
  text: string;
  n: number;
  /** Add to what is already in the box (a held message taken back to edit) instead of replacing it. */
  append?: boolean;
}

interface ComposerProps {
  /** Where the draft is kept: the session id, or `tab:<id>` for an unsent tab. */
  draftKey: string;
  running: boolean;
  waiting: boolean;
  interrupted: boolean;
  inject?: Inject | null;
  autoFocus?: boolean;
  /** Sends the text and the attached files; returns whether it went (the draft is cleared only then). */
  onSend: (text: string, files: AttachmentRefs | null) => Promise<boolean>;
  onStop?: () => void;
  /** The controls row, attached under the text box. */
  controls: ReactNode;
  /** Shown just above the text box: messages held for the agent's next turn. */
  above?: ReactNode;
  /** The slash commands the session's agent offers; typing "/" lists them. Absent or empty: no menu. */
  slashCommands?: readonly SlashCommand[];
  idlePlaceholder?: string;
  /**
   * Other places the typed text can go instead of the session's own agent (a role's agent, in this
   * worktree): a small menu beside Send. `send` returns whether it went; the text is cleared only then.
   */
  sendTo?: { options: readonly { id: string; label: string; hint: string }[]; send: (id: string, text: string) => Promise<boolean> };
}

export function Composer({ draftKey, running, waiting, interrupted, inject, autoFocus, onSend, onStop, controls, above, idlePlaceholder, slashCommands, sendTo }: ComposerProps) {
  const sendToButton = useRef<HTMLButtonElement>(null);
  const [text, setText] = useState(() => drafts.get(draftKey));
  const inputRef = useRef<MessageInputHandle>(null);
  const update = (value: string) => {
    setText(value);
    drafts.set(draftKey, value);
  };
  useEffect(() => {
    if (!inject || inject.id !== draftKey) return;
    const before = drafts.get(draftKey).trim();
    update(inject.append && before ? `${before}\n\n${inject.text}` : inject.text);
    inputRef.current?.focus();
  }, [inject, draftKey]);
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus, draftKey]);
  // While the agent works the box stays open: Enter sends the message into the running turn, and the
  // agent reads it when it can (shared/mid-turn.ts). Only a card waiting for an answer blocks it.
  const blocked = waiting;
  // Files attached to the message: tiles in the box, the paperclip, paste and the page's drop zone.
  const files = useAttachments(draftKey, blocked);
  const empty = !text.trim() && !files.hasFiles;
  const send = async () => {
    const trimmed = text.trim();
    const refs = files.refs();
    if ((!trimmed && !refs) || blocked || files.blocked) return;
    // Cleared at once, so what is typed while the message is on its way starts a new one (a quick
    // second message to queue must not carry the first). Put back if it did not go and the box is still empty.
    update('');
    const went = await onSend(trimmed, refs);
    if (went) files.sent();
    else if (!drafts.get(draftKey).trim()) update(trimmed);
  };
  // The typed text goes to a role's agent instead (Send to Design): put back if it did not go.
  const sendElsewhere = async (id: string) => {
    const trimmed = text.trim();
    if (!trimmed || !sendTo) return;
    update('');
    if (!(await sendTo.send(id, trimmed)) && !drafts.get(draftKey).trim()) update(trimmed);
  };
  // Typing a slash command: the menu of what the agent offers (useSlashMenu.tsx).
  const slash = useSlashMenu(text, slashCommands, blocked, (next) => {
    update(next);
    inputRef.current?.focus();
  });
  return (
    <div className="composer-wrap" ref={files.anchor}>
      {above}
      <div className={`composer-box${files.hasFiles ? ' has-attachments' : ''}`}>
        {slash.menu}
        {files.tiles}
        <MessageInput
          ref={inputRef}
          onPaste={files.onPaste}
          label="Message the agent"
          placeholder={waiting ? 'Answer the question above first…' : running ? 'Message the agent. It is working, and will read this when it can…' : interrupted ? 'Reply to resume this session…' : (idlePlaceholder ?? 'Give a little direction…')}
          value={text}
          disabled={blocked}
          onChange={(value) => {
            update(value);
            slash.onText();
          }}
          onKeyDown={(e) => {
            if (!e.nativeEvent.isComposing && slash.onKey(e)) return void e.preventDefault();
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-actions">
          {files.button}
          {sendTo && sendTo.options.length > 0 && !running && (
            <button
              ref={sendToButton}
              type="button"
              className="send-icon send-to"
              aria-haspopup="menu"
              aria-label="Send this to another agent, in this worktree"
              title="Send what you typed to the agent you chose for Design or Build. It works in this session's worktree and hands back."
              disabled={blocked || !text.trim()}
              onClick={() => openFrom(sendToButton.current!, sendTo.options.map((o) => ({ id: o.id, label: o.label, hint: o.hint })), (item) => void sendElsewhere(item.id))}
            >
              <Split aria-hidden />
            </button>
          )}
          {running && (
            <button className="send-icon stop" aria-label="Stop the agent" title="Stop the agent" onClick={onStop}>
              <Square aria-hidden />
            </button>
          )}
          <button
            className="send-icon"
            aria-label={running ? 'Send (Enter): the agent reads it while it works' : interrupted ? 'Resume (Enter)' : 'Send (Enter). Shift Enter adds a new line'}
            title={files.blocked ?? (running ? 'Send: the agent reads it while it works' : undefined)}
            disabled={blocked || empty || files.blocked !== null}
            onClick={() => void send()}
          >
            <CornerDownLeft aria-hidden />
          </button>
        </div>
      </div>
      <div className="composer-under">{controls}</div>
      {files.dropZone}
    </div>
  );
}
