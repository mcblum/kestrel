// Work the agent left running in the background (a dev server, a long command, a watcher), as a
// compact strip just above the message box while there is any: a pulsing dot beside a short readable name (the
// full command under it in small muted type, cut to one line, and whole in the tooltip), how long it
// has run, and a Stop button. It stays while the session reads as finished: the agent can be done
// talking with this work still running. The list comes from the server (shared/background-tasks.ts) and replaces itself; a
// stopped task leaves it when the agent lists it no more. Helpers are not here: they have their own card.
import { memo, useEffect, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { elapsedText, KIND_LABEL, taskCommand, type LiveBackgroundTask } from '@kestrel/server/background-tasks';
import { taskRowName } from '@kestrel/server/task-row-name';
import { actions, useApp } from '../store.ts';

/** How often the running times move on. They are in minutes, so twice a minute is plenty. */
const TICK_MS = 30_000;
const NONE: readonly LiveBackgroundTask[] = [];

/** The time now, moving on every `ms`. */
function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}

/** What a row is doing after its Stop was pressed: waiting for the list to drop it, or refused with a reason. */
type RowState = { stopping: true } | { error: string };

export const BackgroundTasks = memo(function BackgroundTasks({ sessionId, onOpenCommand }: { sessionId: string; /** Open the Commands pane on a row's command. */ onOpenCommand: (commandId: string) => void }) {
  const tasks = useApp((s) => s.live.get(sessionId)?.backgroundTasks) ?? NONE;
  const commands = useApp((s) => s.live.get(sessionId)?.commands);
  // The Commands pane lists each piece of background work under the tool call that started it.
  const commandFor = (taskId: string) => commands?.find((c) => c.taskId === taskId)?.id ?? null;
  const [rows, setRows] = useState<ReadonlyMap<string, RowState>>(new Map());
  // A new list from the agent is the answer to any Stop pressed: "Stopping…" ends with it.
  useEffect(() => setRows((prev) => new Map([...prev].filter(([, row]) => 'error' in row))), [tasks]);
  if (tasks.length === 0) return null;
  const stop = async (taskId: string) => {
    setRows((prev) => new Map(prev).set(taskId, { stopping: true }));
    const refused = await actions.stopBackgroundTask(sessionId, taskId);
    if (refused) setRows((prev) => new Map(prev).set(taskId, { error: refused }));
  };
  return (
    <div className="bg-tasks" role="group" aria-label="Running in the background">
      <div className="bg-tasks-head">Running in the background</div>
      {tasks.map((task) => (
        <TaskRow key={task.id} task={task} row={rows.get(task.id)} onStop={() => void stop(task.id)} onOpen={commandFor(task.id) === null ? undefined : () => onOpenCommand(commandFor(task.id)!)} />
      ))}
    </div>
  );
});

function TaskRow({ task, row, onStop, onOpen }: { task: LiveBackgroundTask; row: RowState | undefined; onStop: () => void; /** Show it in the Commands pane, when it is listed there. */ onOpen?: () => void }) {
  const now = useNow(TICK_MS);
  const name = taskRowName(task);
  const command = taskCommand(task);
  const kind = KIND_LABEL[task.kind];
  const stopping = !!row && 'stopping' in row;
  const error = row && 'error' in row ? row.error : null;
  return (
    <div className={`bg-task${stopping ? ' stopping' : ''}`}>
      <div className="bg-task-line">
        <span className="working-pulse" aria-hidden />
        {onOpen ? (
          <button type="button" className="bg-task-text bg-task-open" title={`${kind}: ${command ?? name}\nShow its output in Commands`} onClick={onOpen}>
            <span className="bg-task-name">{name}</span>
            {command && <span className="bg-task-command">{command}</span>}
          </button>
        ) : (
          <span className="bg-task-text" title={`${kind}: ${command ?? name}`}>
            <span className="bg-task-name">{name}</span>
            {command && <span className="bg-task-command">{command}</span>}
          </span>
        )}
        <span className="bg-task-time" title={`Running since ${new Date(task.since).toLocaleTimeString()}`}>{elapsedText(task.since, now)}</span>
        <button type="button" className="bg-task-stop" disabled={stopping} aria-label={`Stop ${kind.toLowerCase()}: ${name}`} title="Stop this background work" onClick={onStop}>
          {stopping ? 'Stopping…' : 'Stop'}
        </button>
      </div>
      {error && (
        <p className="bg-task-error" role="alert">
          <CircleAlert aria-hidden />
          {error}
        </p>
      )}
    </div>
  );
}
