// The Commands pane: every command the session's agent is running or ran while Kestrel has been up
// (design doc, "The Commands pane"), whichever way the agent started it. A list on top (running
// first, then the most recently ended), and the chosen command underneath: what it is, when it
// started, how long it ran, how it ended, Stop where the agent can stop it on its own (and why not
// where it cannot), and what it printed. Output is asked for while the pane shows a running command,
// about once a second, and once more when it ends. The list itself comes on the live channel.
import { memo, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { CircleAlert } from 'lucide-react';
import { elapsedText, KIND_LABEL, taskCommand } from '@kestrel/server/background-tasks';
import { taskRowName } from '@kestrel/server/task-row-name';
import { ENDED_TEXT, STATUS_LABEL, type CommandOutput, type SessionCommand } from '@kestrel/server/commands';
import { commandMenu } from '@kestrel/server/menu';
import { contextMenu } from '../menuState.ts';
import { actions, messageFor, useApp } from '../store.ts';
import { PaneHead } from './PaneHead.tsx';
import { isTypedText } from '../typed-text.ts';

/** How often a running command's output is asked for while it is shown. */
const POLL_MS = 1000;
/** How often running times move on. */
const TICK_MS = 15_000;
const NONE: readonly SessionCommand[] = [];
/** The list's height to begin with: 10 rows of 28px and its padding. */
const LIST_DEFAULT_PX = 288;
/** The least either side keeps while the line between them is dragged. */
const LIST_MIN_PX = 64;
const DETAIL_MIN_PX = 120;
const NUDGE_PX = 28;
const HEIGHT_KEY = 'kestrel.commands.listHeight';
const SOURCE_HEIGHT_KEY = 'kestrel.commands.sourceHeight';
/** The least the command text and the output keep while the line between them is dragged. */
const SOURCE_MIN_PX = 24;
const OUTPUT_MIN_PX = 64;
/** How long "Copied" shows on the command text after a click. */
const COPIED_MS = 1500;

interface Props {
  sessionId: string;
  /** The command to show, from the pane state; null or unknown: the first in the list. */
  selectedId: string | null;
  onSelect: (commandId: string) => void;
  /** The pane is on screen: output is only asked for then. */
  visible: boolean;
}

export const CommandsPane = memo(function CommandsPane({ sessionId, selectedId, onSelect, visible }: Props) {
  const commands = useApp((s) => s.live.get(sessionId)?.commands) ?? NONE;
  const now = useNow(TICK_MS);
  const selected = commands.find((c) => c.id === selectedId) ?? commands[0] ?? null;
  const running = commands.filter((c) => c.status === 'running').length;
  const pane = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useListHeight();
  return (
    <div className="commands-pane" ref={pane}>
      <PaneHead pane="commands" name="Commands">
        {running > 0 && <span className="commands-running">{running} running</span>}
      </PaneHead>
      {commands.length === 0 ? (
        <div className="context-content">
          <h3>No commands yet</h3>
          <p>Commands the agent runs in this session show here while they run, with what they print. Ones that have ended stay listed, across restarts too; right-click one to have the agent run it again, or to copy it or what it printed.</p>
        </div>
      ) : (
        <>
          <div className="commands-list" role="listbox" aria-label="Commands" style={{ height: listHeight }}>
            {commands.map((c) => (
              <CommandRow key={c.id} sessionId={sessionId} command={c} now={now} selected={c === selected} onSelect={() => onSelect(c.id)} />
            ))}
          </div>
          <ListDivider height={listHeight} pane={pane} onResize={setListHeight} />
          {selected && <CommandDetail key={selected.id} sessionId={sessionId} command={selected} now={now} visible={visible} />}
        </>
      )}
    </div>
  );
});

/** A dividing line being dragged: `onMove` hears how far down the pointer is from where it was pressed. */
function dragLine(event: ReactPointerEvent<HTMLDivElement>, onMove: (movedPx: number) => void): void {
  event.preventDefault();
  const handle = event.currentTarget;
  const startY = event.clientY;
  handle.setPointerCapture(event.pointerId);
  const move = (e: PointerEvent) => onMove(e.clientY - startY);
  const stop = () => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', stop);
    handle.removeEventListener('pointercancel', stop);
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);
}

/** The line between the list and the chosen command: drag it, or arrow keys on it; double-click puts it back. */
function ListDivider({ height, pane, onResize }: { height: number; pane: RefObject<HTMLDivElement | null>; onResize: (px: number) => void }) {
  const clamp = (px: number) => {
    const el = pane.current;
    const list = el?.querySelector('.commands-list');
    // The most the list may take: the pane below the list's top, less what the output keeps.
    const room = el && list ? el.getBoundingClientRect().bottom - list.getBoundingClientRect().top - DETAIL_MIN_PX : px;
    return Math.round(Math.max(LIST_MIN_PX, Math.min(px, Math.max(LIST_MIN_PX, room))));
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => dragLine(event, (moved) => onResize(clamp(height + moved)));
  return (
    <div
      className="commands-divider"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the command list and its output"
      aria-valuenow={height}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => onResize(clamp(LIST_DEFAULT_PX))}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') onResize(clamp(height - NUDGE_PX));
        if (e.key === 'ArrowDown') onResize(clamp(height + NUDGE_PX));
      }}
    />
  );
}

/** A height kept in this window (browser storage; it may be unavailable, and then it is just the default). Null takes it back to the default. */
function useKeptHeight<T extends number | null>(key: string, least: number, fallback: T): [number | T, (px: number | T) => void] {
  const [height, setHeight] = useState<number | T>(() => {
    try {
      const kept = window.localStorage.getItem(key);
      const saved = Number(kept);
      return kept !== null && Number.isFinite(saved) && saved >= least ? saved : fallback;
    } catch {
      return fallback;
    }
  });
  const set = (px: number | T) => {
    setHeight(px);
    try {
      if (px === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, String(px));
    } catch {
      // Not kept: the next window starts at the default.
    }
  };
  return [height, set];
}

const useListHeight = () => useKeptHeight(HEIGHT_KEY, LIST_MIN_PX, LIST_DEFAULT_PX);
/** The command text's height once its line has been dragged; null until then (it is as tall as it needs, up to six lines). */
const useSourceHeight = () => useKeptHeight<null>(SOURCE_HEIGHT_KEY, SOURCE_MIN_PX, null);

function CommandRow({ sessionId, command, now, selected, onSelect }: { sessionId: string; command: SessionCommand; now: number; selected: boolean; onSelect: () => void }) {
  const name = taskRowName(command);
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={`command-row${selected ? ' selected' : ''}`}
      onClick={onSelect}
      // Right-click: the command's menu (Stop, Retry or Re-run; Copy command; Copy command output), from the one place menus are defined.
      onContextMenu={(event) => {
        if (isTypedText(event.target)) return;
        event.preventDefault();
        onSelect();
        contextMenu.open(event.clientX, event.clientY, commandMenu(sessionId, command, taskCommand(command)));
      }}
      title={`${KIND_LABEL[command.kind]}: ${taskCommand(command) ?? name}`}
    >
      <StatusMark status={command.status} />
      <span className="command-row-name">{name}</span>
      <span className={`command-row-time ${command.status}`}>{command.status === 'running' ? elapsedText(command.since, now) : STATUS_LABEL[command.status]}</span>
    </button>
  );
}

function StatusMark({ status }: { status: SessionCommand['status'] }) {
  if (status === 'running') return <span className="working-pulse" aria-label="Running" />;
  return <span className={`command-mark ${status}`} aria-label={STATUS_LABEL[status]} />;
}

function CommandDetail({ sessionId, command, now, visible }: { sessionId: string; command: SessionCommand; now: number; visible: boolean }) {
  const output = useCommandOutput(sessionId, command, visible);
  // Two parts that scroll on their own: the command itself, which is kept short however long it is,
  // and its output, which always has the rest of the pane. The output follows its end as it grows
  // only when the user is at the end already, or it all still fits.
  const scroller = useRef<HTMLPreElement>(null);
  const atEnd = useRef(false);
  const text = output.value?.text ?? '';
  useEffect(() => {
    const el = scroller.current;
    if (!el || !output.value) return;
    if (atEnd.current) el.scrollTop = el.scrollHeight;
    else if (el.scrollHeight <= el.clientHeight + 8) atEnd.current = true;
  }, [text, output.value]);
  const onOutputScroll = (el: HTMLElement) => {
    atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
  };
  const [stop, setStop] = useState<{ stopping: true } | { error: string } | null>(null);
  const line = taskCommand(command);
  const [sourceHeight, setSourceHeight] = useSourceHeight();
  const running = command.status === 'running';
  const canStop = running && !command.noStop;
  const onStop = async () => {
    setStop({ stopping: true });
    const refused = await actions.stopCommand(sessionId, command.id);
    setStop(refused ? { error: refused } : null);
  };
  return (
    <section className="command-detail" aria-label={`${taskRowName(command)}: details and output`}>
      <div className="command-head">
        <div className="command-title">
          <span className="command-name" title={taskRowName(command)}>
            {taskRowName(command)}
          </span>
          <span className="command-facts">
            Started {new Date(command.since).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} ·{' '}
            {command.status === 'running' ? `running ${elapsedText(command.since, now)}` : `${ENDED_TEXT[command.status]} after ${elapsedText(command.since, command.endedAt ?? now)}`}
          </span>
        </div>
        {canStop && (
          <button type="button" className="bg-task-stop" disabled={!!stop && 'stopping' in stop} onClick={() => void onStop()}>
            {stop && 'stopping' in stop ? 'Stopping…' : 'Stop'}
          </button>
        )}
      </div>
      {running && command.noStop && <p className="command-note">{command.noStop}</p>}
      {stop && 'error' in stop && (
        <p className="bg-task-error" role="alert">
          <CircleAlert aria-hidden />
          {stop.error}
        </p>
      )}
      {line && <CommandSource line={line} height={sourceHeight} />}
      {line && <SourceDivider height={sourceHeight} onResize={setSourceHeight} />}
      <OutputView output={output} scroller={scroller} onScroll={onOutputScroll} />
    </section>
  );
}

/**
 * The command as it was run. A click copies all of it, and hovering says so; a click that ends a
 * selection copies nothing, so part of it can still be selected and copied by hand.
 */
function CommandSource({ line, height }: { line: string; height: number | null }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = () => {
    if (window.getSelection()?.toString()) return;
    void navigator.clipboard.writeText(line).then(() => setCopied(true), () => undefined);
  };
  return (
    <div className="command-source" style={height === null ? undefined : { height }}>
      <code
        className="command-line"
        role="button"
        tabIndex={0}
        aria-label="Command. Click to copy"
        onClick={copy}
        onKeyDown={(e) => {
          if (e.key === 'Enter') copy();
        }}
      >
        {line}
      </code>
      <span className="command-copy-hint" aria-live="polite">
        {copied ? 'Copied' : 'Click to copy'}
      </span>
    </div>
  );
}

/** The line between the command text and its output: drag it, or arrow keys on it; double-click puts it back. */
function SourceDivider({ height, onResize }: { height: number | null; onResize: (px: number | null) => void }) {
  const line = useRef<HTMLDivElement>(null);
  // Where the text's height stands now, and the most it may take: the details below its top, less what the output keeps.
  const measure = () => {
    const source = line.current?.previousElementSibling;
    const detail = line.current?.parentElement;
    if (!source || !detail) return null;
    const box = source.getBoundingClientRect();
    return { now: box.height, room: detail.getBoundingClientRect().bottom - box.top - OUTPUT_MIN_PX };
  };
  const clamp = (px: number, room: number) => Math.round(Math.max(SOURCE_MIN_PX, Math.min(px, Math.max(SOURCE_MIN_PX, room))));
  const nudge = (by: number) => {
    const at = measure();
    if (at) onResize(clamp(at.now + by, at.room));
  };
  return (
    <div
      ref={line}
      className="commands-divider source-divider"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the command and its output"
      aria-valuenow={height ?? undefined}
      tabIndex={0}
      onPointerDown={(event) => {
        const at = measure();
        if (at) dragLine(event, (moved) => onResize(clamp(at.now + moved, at.room)));
      }}
      onDoubleClick={() => onResize(null)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') nudge(-NUDGE_PX);
        if (e.key === 'ArrowDown') nudge(NUDGE_PX);
      }}
    />
  );
}

interface OutputViewProps {
  output: { value: CommandOutput | null; error: string | null };
  scroller: RefObject<HTMLPreElement | null>;
  onScroll: (el: HTMLElement) => void;
}

function OutputView({ output, scroller, onScroll }: OutputViewProps) {
  if (output.error) return <p className="command-note">Kestrel could not get its output: {output.error}</p>;
  if (!output.value) return <p className="command-note">Loading its output…</p>;
  const text = output.value.text;
  return (
    <>
      {output.value.truncated && <p className="command-note">Showing the end of its output.</p>}
      {text ? (
        <pre ref={scroller} tabIndex={0} className="command-output" aria-label="Output" onScroll={(e) => onScroll(e.currentTarget)}>
          {text}
        </pre>
      ) : (
        <p className="command-note">{output.value.note ?? 'It printed nothing.'}</p>
      )}
    </>
  );
}

/** The command's output: asked for now, every POLL_MS while it runs and the pane is visible, and once more when it ends. */
function useCommandOutput(sessionId: string, command: SessionCommand, visible: boolean): { value: CommandOutput | null; error: string | null } {
  const [state, setState] = useState<{ value: CommandOutput | null; error: string | null }>({ value: null, error: null });
  const running = command.status === 'running';
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timer: number | undefined;
    const ask = async () => {
      try {
        const value = await actions.commandOutput(sessionId, command.id);
        if (!cancelled) setState((prev) => (prev.value && prev.value.text === value.text && prev.value.note === value.note && prev.value.truncated === value.truncated && !prev.error ? prev : { value, error: null }));
      } catch (error) {
        if (!cancelled) setState((prev) => ({ value: prev.value, error: messageFor(error) }));
      }
      if (!cancelled && running) timer = window.setTimeout(() => void ask(), POLL_MS);
    };
    void ask();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [sessionId, command.id, running, visible]);
  return state;
}

/** The time now, moving on every `ms`. */
function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}
