// What the agent leaves in the conversation besides text: its task list, a file it made for
// you, and the next-step box at the end of a turn.
import { memo } from 'react';
import { showInManager } from '../platform.ts';
import { Check, FileText, FolderOpen, MessageCircle } from 'lucide-react';
import type { FileCard, NextStep, TodoItem } from '@kestrel/server/model';
import { Markdown } from './Markdown.tsx';
import { Thumb } from './Pictures.tsx';
import { CopyButton } from './CopyButton.tsx';
import { actions } from '../store.ts';
import { viewableKind } from '@kestrel/server/viewable-files';
import { openSessionFile } from '../sessionView.ts';

// ---- task list --------------------------------------------------------------------------

function TodoMark({ status }: { status: TodoItem['status'] }) {
  if (status === 'completed') return <Check className="todo-mark" aria-hidden />;
  if (status === 'in_progress') return <span className="todo-mark working-pulse" aria-hidden />;
  return <span className="todo-mark todo-circle" aria-hidden />;
}

const STATUS_LABEL = { completed: 'done', in_progress: 'in progress', pending: 'to do' } as const;

function TodoList({ todos }: { todos: readonly TodoItem[] }) {
  return (
    <ul className="todo-list">
      {todos.map((t, i) => (
        <li key={t.id ?? i} className={`todo-${t.status}`}>
          <span className="todo-slot">
            <TodoMark status={t.status} />
          </span>
          <span className="todo-text">
            {t.text}
            <span className="visually-hidden"> ({STATUS_LABEL[t.status]})</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The agent's checklist. Once every item is done it folds to one line that opens on click. */
export const TodoCard = memo(function TodoCard({ todos }: { todos: readonly TodoItem[] }) {
  const done = todos.filter((t) => t.status === 'completed').length;
  if (todos.length > 0 && done === todos.length)
    return (
      <details className="tool-activity todo-folded">
        <summary>
          <Check aria-hidden />
          <span className="step-summary">
            {todos.length} {todos.length === 1 ? 'task' : 'tasks'} done
          </span>
        </summary>
        <TodoList todos={todos} />
      </details>
    );
  return (
    <div className="todo-card" role="group" aria-label="Tasks">
      <div className="todo-head">
        Tasks · {done} of {todos.length}
      </div>
      <TodoList todos={todos} />
    </div>
  );
});

// ---- a file the agent made --------------------------------------------------------------

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = unit === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${shown} ${UNITS[unit]}`;
}

export const FileCardView = memo(function FileCardView({ file, sessionId }: { file: FileCard; sessionId: string }) {
  const note = file.caption ?? (file.bytes !== undefined ? formatBytes(file.bytes) : null);
  return (
    <div className="file-card">
      <div className="file-card-row">
        <FileText className="file-card-icon" aria-hidden />
        {viewableKind(file.name) ? (
          <button type="button" className="file-card-name file-card-open" title={`Open ${file.path} in a tab`} onClick={() => openSessionFile(sessionId, file.path)}>
            {file.name}
          </button>
        ) : (
          <span className="file-card-name" title={file.path}>
            {file.name}
          </span>
        )}
        {note && <span className="file-card-note">{note}</span>}
        <span className="file-card-actions">
          <button type="button" className="copy-button" aria-label={showInManager()} onClick={() => void actions.reveal(file.path)}>
            <FolderOpen aria-hidden />
          </button>
          <CopyButton value={file.path} label="path" />
        </span>
      </div>
      {IMAGE_EXT.test(file.name) && (
        <div className="thumb-row">
          <Thumb sessionId={sessionId} kind="raw" name={file.path} alt={file.name} quiet />
        </div>
      )}
    </div>
  );
});

// ---- next step --------------------------------------------------------------------------

/** Where the turn left things, and the replies the agent suggests. Spent once you have replied. */
export function NextStepBox({ next, sessionId, onReply }: { next: NextStep; sessionId: string; onReply: (text: string) => void }) {
  const live = !next.done && next.replies.length > 0;
  return (
    <div className={`next-step${live ? ' next-step-prompt' : ''}`} role="group" aria-label="Next step">
      {live && <div className="next-step-heading"><MessageCircle size={14} aria-hidden /><span>Next step</span></div>}
      <div className="next-recap prose">
        <Markdown text={next.recap} sessionId={sessionId} />
      </div>
      {!next.done && next.ask && <p className="next-ask">{next.ask}</p>}
      {live && (
        <div className="decision-options explicit">
          {next.replies.map((reply, i) => (
            <button key={reply} className={i === 0 ? 'primary' : ''} onClick={() => onReply(reply)}>
              {reply}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
