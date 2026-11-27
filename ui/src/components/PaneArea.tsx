// The main content of a page (a session's conversation, a project or group page) and the side
// panes beside it, laid out by `paneLayout` (@kestrel/server/pane-layout): Context nearest the
// main content (or floating over it when it does not fit), Changes, the tools column (Files,
// Browser, Terminal stacked), the Simulator. Every pane belongs to the
// page's scope. The main content keeps its minimum width, and gives way to its squeezed minimum
// when the columns at theirs do not fit beside it; past that they scroll sideways inside their own
// area, with a scroll bar that shows. A column or stacked pane that was on stays mounted,
// out of sight, after it is turned off, so nothing in it is lost.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CONTEXT_WIDTH_LIMITS, contextCardWidth, PANE_WIDTH, paneLayout, SIM_WIDTH, type LayoutColumn, type PaneId, type StackPane } from '@kestrel/server/pane-layout';
import { parseScope, type Scope } from '@kestrel/server/scope';
import type { PaneState } from '../paneState.ts';
import { tabActions, useTabs } from '../tabsStore.ts';
import { reportPanes } from '../sidebarRail.ts';
import { BrowserView } from './BrowserPane.tsx';
import { FilesPane } from './FilesPane.tsx';
import { PaneCloser, PaneHead } from './PaneHead.tsx';
import { OpenIn } from './OpenIn.tsx';
import { ResizeEdge } from './ResizeEdge.tsx';
import { SimulatorColumn } from './SimulatorPane.tsx';
import { TerminalPane } from './TerminalPane.tsx';
import { ToolStack } from './ToolStack.tsx';

interface Props {
  scopeKey: string;
  state: PaneState;
  /** The page itself: it fills what the columns leave. */
  main: ReactNode;
  mainLabel: string;
  changes?: ReactNode;
  context?: ReactNode;
  /** A sub-agent's output, when the session shows one. */
  agent?: ReactNode;
  /** A sidebar about a finding, when the session shows one (shared/asides.ts). */
  aside?: ReactNode;
  /** The session's commands (sessions only), told whether the pane is on screen. */
  commands?: (visible: boolean) => ReactNode;
  /** Where this scope's terminals open, when that needs saying. */
  terminalNote?: string;
  /** What the Context pane is called here (a session calls it Details). */
  contextLabel?: string;
  /** Turn a pane off: its X, and for the floating Context card also Escape or a click outside it. */
  onClosePane: (pane: PaneId) => void;
  /** A session on another computer: that computer's name. Its terminal, browser and simulator are there and never open here, and its folder is not opened from here. */
  elsewhere?: string | null;
}

/** The panes that stay on the computer a session runs on (shared/machines.ts `paneThere`). */
const PANES_THERE = ['terminal', 'browser', 'simulator'] as const;

/** An Escape meant for something else: typing, a terminal, an open menu or picker. */
export const escapeBelongsElsewhere = (event: KeyboardEvent) => {
  const target = event.target instanceof Element ? event.target : null;
  if (event.defaultPrevented || target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .xterm')) return true;
  return document.querySelector('.context-menu, .picker-pop') !== null;
};

/** Close the floating Context card on Escape or a press outside it (its own toolbar button toggles it). */
function useDismiss(card: HTMLElement | null, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!card) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && !escapeBelongsElsewhere(event) && close.current();
    const onPointer = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target && !card.contains(target) && !target.closest('.pane-icons')) close.current();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [card]);
}

const widthOf = (columns: readonly LayoutColumn[], id: LayoutColumn['id']) => columns.find((c) => c.id === id)?.width;

export function PaneArea({ scopeKey, state: given, main, mainLabel, changes, context, agent, aside, commands, terminalNote, contextLabel = 'Context', onClosePane, elsewhere = null }: Props) {
  // Kept while the given state is the same, so what follows it does not run again on every draw.
  const state = useMemo(() => (elsewhere && PANES_THERE.some((p) => given.open[p]) ? { ...given, open: { ...given.open, terminal: false, browser: false, simulator: false } } : given), [given, elsewhere]);
  const scope = parseScope(scopeKey) as Scope;
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [available, setAvailable] = useState(() => window.innerWidth);
  useEffect(() => {
    if (!root) return;
    const observer = new ResizeObserver(() => setAvailable(Math.round(root.getBoundingClientRect().width)));
    observer.observe(root, { box: 'border-box' });
    return () => observer.disconnect();
  }, [root]);
  // The sidebar turns into a rail when the window cannot fit it beside these panes (sidebarRail.ts).
  useEffect(() => reportPanes(scopeKey, state.open), [scopeKey, state.open]);
  useEffect(() => () => reportPanes(scopeKey, null), [scopeKey]);
  const widths = useTabs((v) => v.sidebar);
  const layout = paneLayout(state.open, available, { changes: widths.changesWidth, tools: widths.paneWidth, simulator: widths.simWidth, context: widths.contextWidth });

  // Everything that has been on stays mounted while this page is.
  const mounted = useRef(new Set<StackPane | 'simulator'>());
  for (const pane of layout.stack) mounted.current.add(pane);
  if (state.open.simulator) mounted.current.add('simulator');
  const stackMounted = new Set([...mounted.current].filter((p): p is StackPane => p !== 'simulator'));
  // A parked column keeps the width it would have, so what is in it stays laid out at that size.
  const parkedWidth = (id: 'tools' | 'simulator', fallback: number) => widthOf(layout.columns, id) ?? fallback;

  const openInWhat = scope.kind === 'session' ? "this session's folder" : "this project's folder";
  const renderPane = (pane: StackPane, visible: boolean) => {
    if (pane === 'files')
      return (
        <>
          <PaneHead pane="files" name="Files">
            {!elsewhere && <OpenIn scope={scopeKey} what={openInWhat} />}
          </PaneHead>
          <FilesPane scopeKey={scopeKey} />
        </>
      );
    if (pane === 'terminal') return <TerminalPane scopeKey={scopeKey} note={terminalNote} visible={visible} />;
    if (pane === 'browser') return <BrowserView scopeKey={scopeKey} visible={visible} />;
    if (pane === 'commands') return commands?.(visible) ?? null;
    if (pane === 'aside') return aside ?? null;
    return agent ?? null;
  };

  const [card, setCard] = useState<HTMLElement | null>(null);
  useDismiss(card, () => onClosePane('context'));
  // The Context pane under its head; the head stays put while the content scrolls.
  const contextPane = context && (
    <>
      <PaneHead pane="context" name={contextLabel} />
      <div className="pane-body">{context}</div>
    </>
  );

  const changesWidth = widthOf(layout.columns, 'changes');
  // The Details pane: beside the main content at the width the layout gives it, or floating at the width it was dragged to.
  const contextWidth = widthOf(layout.columns, 'context');
  const cardWidth = contextCardWidth(widths.contextWidth);
  return (
    <PaneCloser.Provider value={onClosePane}>
    <div className={`pane-layout${layout.overflows ? ' overflows' : ''}`} ref={setRoot}>
      <section className="pane-main" aria-label={mainLabel} style={{ minWidth: `min(${layout.mainMin}px, 100%)` }}>
        {main}
        {layout.contextFloats && context && (
          <aside className="context-card" aria-label={contextLabel} ref={setCard} style={{ width: cardWidth }}>
            <ResizeEdge width={cardWidth} limits={CONTEXT_WIDTH_LIMITS} onResize={tabActions.setContextWidth} label="Resize the details pane" />
            {contextPane}
          </aside>
        )}
      </section>
      <div className="pane-columns">
        {widthOf(layout.columns, 'context') !== undefined && (
          <aside className="inspection context-column" aria-label={contextLabel} style={{ width: contextWidth }}>
            <ResizeEdge width={contextWidth ?? CONTEXT_WIDTH_LIMITS.initial} limits={CONTEXT_WIDTH_LIMITS} onResize={tabActions.setContextWidth} label="Resize the details pane" />
            {contextPane}
          </aside>
        )}
        {changesWidth !== undefined && (
          <section className="inspection" aria-label="Changes" style={{ width: changesWidth }}>
            <ResizeEdge width={changesWidth} limits={PANE_WIDTH} onResize={tabActions.setChangesWidth} label="Resize the changes column" />
            <PaneHead pane="changes" name="Changes">
              {!elsewhere && <OpenIn scope={scopeKey} what={openInWhat} />}
            </PaneHead>
            <div className="inspector-content">{changes}</div>
          </section>
        )}
        {stackMounted.size > 0 && <ToolStack kind={scope.kind} stack={layout.stack} mounted={stackMounted} width={parkedWidth('tools', widths.paneWidth ?? PANE_WIDTH.initial)} render={renderPane} />}
        {mounted.current.has('simulator') && <SimulatorColumn scopeKey={scopeKey} sessionId={scope.kind === 'session' ? scope.id : null} visible={state.open.simulator} width={parkedWidth('simulator', widths.simWidth ?? SIM_WIDTH.initial)} />}
      </div>
    </div>
    </PaneCloser.Provider>
  );
}
