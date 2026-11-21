// A scope's terminals (a session's, a project page's, a group page's): a strip of tabs (or, past a
// few, one menu: TerminalStrip.tsx), one shell each, like a terminal app's own tabs. Every tab keeps its xterm while the pane is mounted (only
// the chosen one shows), and the shells keep running on the server when the pane closes, so coming
// back finds them with their output. A session's open in its folder, a project's in the project
// folder, a group's in the home folder (a group has no folder; `note` says so).
import { codeFontStack, terminalColors } from '@kestrel/server/appearance';
import { appearance, drawnDark, onAppearance, useAppearance } from '../appearance.ts';
import { useContext, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { PaneCloser, PaneHead } from './PaneHead.tsx';
import { TerminalActions } from './TerminalActions.tsx';
import { TerminalStrip } from './TerminalStrip.tsx';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { terminals, useTerminals, type TerminalInfo, type TerminalStream } from '../terminalStore.ts';

/** Opens a terminal from inside the pane. Ctrl, not Cmd: Cmd+T and Cmd+W already belong to the app's tabs. */
const NEW_SHORTCUT = '⌃⇧`';
const isNewShortcut = (e: { ctrlKey: boolean; shiftKey: boolean; metaKey: boolean; altKey: boolean; code: string }) => e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && e.code === 'Backquote';
const DEFAULT_SIZE = { cols: 100, rows: 30 };

/** The tab chosen in each scope, for the life of the page. */
const chosenTab = new Map<string, string>();
/** Scopes with a first shell on its way, so a remount in that moment does not start a second. */
const starting = new Set<string>();
/** The last "bring this terminal forward" request each scope acted on, so a remount does not act on it again. */
const frontShown = new Map<string, number>();

export function TerminalPane({ scopeKey: sessionId, note, visible }: { scopeKey: string; /** Where the shells open, when that needs saying. */ note?: string; /** The pane is on screen (it stays mounted while hidden). */ visible: boolean }) {
  const { listed, terminals: list, error, front } = useTerminals(sessionId);
  const [chosen, setChosen] = useState<string | null>(() => chosenTab.get(sessionId) ?? null);
  const lastSize = useRef(DEFAULT_SIZE);
  const active = list.find((t) => t.id === chosen)?.id ?? list.at(-1)?.id ?? null;

  const choose = (id: string) => {
    chosenTab.set(sessionId, id);
    setChosen(id);
  };
  const create = () => terminals.create(sessionId, lastSize.current, choose);

  useEffect(() => terminals.follow(sessionId), [sessionId]);
  // A code block started running in a terminal: show that one.
  useEffect(() => {
    if (!front || frontShown.get(sessionId) === front.seq) return;
    frontShown.set(sessionId, front.seq);
    choose(front.id);
  }, [front?.seq]);
  // The pane always has a terminal in it: showing it with none starts one, and when the last one
  // goes while it is showing (its tab closed, or its shell exited) the pane closes with it. The pane
  // stays mounted while hidden, so "showing" is `visible`, not being mounted.
  const closePane = useContext(PaneCloser);
  const had = useRef(false);
  useEffect(() => {
    if (!listed) return;
    if (list.length > 0) {
      had.current = true;
      starting.delete(sessionId);
      return;
    }
    const lostLast = had.current;
    had.current = false;
    if (!visible) return;
    if (lostLast) {
      closePane?.('terminal');
      return;
    }
    if (starting.has(sessionId)) return;
    starting.add(sessionId);
    create();
    // `create` and `closePane` are fresh each render; only the list, and the pane being shown, matter here.
  }, [listed, list.length, sessionId, visible]);
  // A shell that could not start (no folder, not connected) says why; opening the pane again tries again.
  useEffect(() => {
    if (error) starting.delete(sessionId);
  }, [error, sessionId]);

  const close = (t: TerminalInfo) => {
    if (t.busy && !window.confirm(`“${t.title}” is still running. Close this terminal and stop it?`)) return;
    if (t.id === active) {
      const at = list.findIndex((x) => x.id === t.id);
      const next = list[at + 1] ?? list[at - 1];
      if (next) choose(next.id);
    }
    terminals.close(sessionId, t.id);
  };

  // Keys for the pane, wherever focus is inside it, the shell included.
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (!isNewShortcut(e)) return;
    e.preventDefault();
    create();
  };

  return (
    <div className="terminal-view" onKeyDown={onKeyDown}>
      {/* Between opening the pane and its first shell arriving there is only the pane's own head. */}
      {list.length > 0 ? (
        <TerminalStrip
          list={list}
          active={active}
          newTip={`New terminal (${NEW_SHORTCUT})${note ? `. ${note}` : ''}`}
          onChoose={choose}
          onClose={close}
          onNew={create}
          actions={<TerminalActions scopeKey={sessionId} />}
          onRename={(id, title) => terminals.rename(sessionId, id, title)}
          onMove={(id, target, after) => terminals.move(sessionId, id, target, after)}
        />
      ) : (
        <PaneHead pane="terminal" name="Terminal" />
      )}
      {error && <p className="files-note">{error}</p>}
      {list.map((t) => (
        <TerminalScreen key={t.id} sessionId={sessionId} terminalId={t.id} visible={t.id === active} onSize={(size) => (lastSize.current = size)} />
      ))}
    </div>
  );
}

// ---- one shell ------------------------------------------------------------------------------

interface ScreenProps {
  sessionId: string;
  terminalId: string;
  visible: boolean;
  onSize: (size: { cols: number; rows: number }) => void;
}

/** One terminal's xterm. It lives while the pane is open; hiding it does not end it. */
function TerminalScreen({ sessionId, terminalId, visible, onSize }: ScreenProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<{ term: Terminal; fit: FitAddon } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The latest handler, so the xterm set up once always calls the current one.
  const sized = useRef(onSize);
  sized.current = onSize;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = makeTerminal();
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    view.current = { term, fit };
    fitIfShown(el, fit);
    // Ctrl+Shift+` is the pane's (it opens a terminal): xterm leaves it alone and it reaches the pane.
    term.attachCustomKeyEventHandler((e) => !isNewShortcut(e));
    const leave = terminals.attach(sessionId, terminalId, { cols: term.cols, rows: term.rows }, (event) => onStream(term, event, setProblem));
    const typed = term.onData((data) => terminals.input(sessionId, terminalId, data));
    const resized = term.onResize(({ cols, rows }) => {
      terminals.resize(sessionId, terminalId, { cols, rows });
      sized.current({ cols, rows });
    });
    const observer = new ResizeObserver(() => fitIfShown(el, fit));
    observer.observe(el, { box: 'border-box' });
    return () => {
      observer.disconnect();
      typed.dispose();
      resized.dispose();
      leave();
      view.current = null;
      // open() leaves xterm a viewport sync queued for the next task (a zero-delay timer). Disposing
      // first (StrictMode's mount-unmount-mount, or a pane closed right after it opened) makes that
      // sync read the disposed renderer: "Cannot read properties of undefined (reading 'dimensions')".
      // Everything above already let go of the terminal; dispose it after the queued sync has run.
      setTimeout(() => term.dispose());
    };
  }, [sessionId, terminalId]);

  // The look changed (Settings → General → Appearance, or the system's theme): this terminal takes it and is fitted again.
  const look = useAppearance();
  const [, redraw] = useState(0);
  useEffect(() => {
    const restyle = () => {
      const current = view.current;
      if (current) {
        current.term.options.theme = terminalTheme();
        current.term.options.fontFamily = codeFontStack(appearance().codeFont);
        current.term.options.fontSize = appearance().terminalFontSize;
        if (host.current) fitIfShown(host.current, current.fit);
      }
      redraw((n) => n + 1); // the inset around the text is the terminal's colour too
    };
    restyle();
    return onAppearance(restyle);
  }, [look]);

  // Shown again: it may have missed a resize while hidden; and the chosen tab takes the keys.
  useEffect(() => {
    const current = view.current;
    if (!visible || !current || !host.current) return;
    fitIfShown(host.current, current.fit);
    current.term.focus();
  }, [visible]);

  return (
    // The inset around the text is the terminal's own colour, so it reads as the terminal, not a frame.
    // The host inside it has no padding: the fit measures the host, so it counts only what is visible.
    <div className="term-screen" hidden={!visible} style={{ background: terminalTheme().background }}>
      {problem && <p className="files-note">{problem}</p>}
      <div className="terminal-host" ref={host} />
    </div>
  );
}

/** The palette follows the app: grey surfaces, with xterm's own colours for program output. */
function terminalTheme() {
  return terminalColors(drawnDark(), appearance().contrast);
}

function makeTerminal(): Terminal {
  return new Terminal({
    cursorBlink: true,
    fontFamily: codeFontStack(appearance().codeFont),
    fontSize: appearance().terminalFontSize,
    scrollback: 5000,
    theme: terminalTheme(),
  });
}

/** A hidden screen has no size; fitting it then would shrink the shell to nothing. */
function fitIfShown(el: HTMLElement, fit: FitAddon) {
  if (el.offsetWidth > 0 && el.offsetHeight > 0) fit.fit();
}

function onStream(term: Terminal, event: TerminalStream, setProblem: (problem: string | null) => void) {
  if (event.type === 'data') term.write(event.data);
  else if (event.type === 'replay') term.reset(); // the socket came back; its output is sent again from the start
  else if (event.type === 'exit') term.write(`\r\n\x1b[2m[the shell exited${event.code ? ` with code ${event.code}` : ''}; close this tab or open a new one]\x1b[0m\r\n`);
  else setProblem(event.message);
}
