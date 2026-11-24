// The tools column: Files, Browser and Terminal (and a sub-agent's output above them), stacked
// top to bottom when more than one is on, with a draggable divider between each two. Heights are
// kept per page kind with the column widths; double-clicking a divider shares the column evenly.
// A pane that was on once stays mounted while it is off (out of sight, still laid out), so a
// terminal keeps its shells and the browser its page.
import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { dragDivider, PANE_WIDTH, STACK_ORDER, stackShares, type StackPane, type StackWeights } from '@kestrel/server/pane-layout';
import type { ScopeKind } from '@kestrel/server/scope';
import { tabActions, useTabs } from '../tabsStore.ts';
import { ResizeEdge } from './ResizeEdge.tsx';
import { ASIDE_NAME } from '@kestrel/server/asides';

const NO_WEIGHTS: StackWeights = {};
const LABEL: Record<StackPane, string> = { aside: ASIDE_NAME, agent: 'Sub-agent output', files: 'Files', browser: 'Browser', commands: 'Commands', terminal: 'Terminal' };

interface Props {
  kind: ScopeKind;
  /** What is on, top to bottom. Empty: the column is parked out of sight. */
  stack: readonly StackPane[];
  /** Every pane that has been on, so it stays mounted. */
  mounted: ReadonlySet<StackPane>;
  width: number;
  render: (pane: StackPane, visible: boolean) => ReactNode;
}

export function ToolStack({ kind, stack, mounted, width, render }: Props) {
  const weights = useTabs((v) => v.sidebar.stack?.[kind] ?? NO_WEIGHTS);
  const box = useRef<HTMLDivElement>(null);
  const shares = stackShares(stack, weights);
  const parked = stack.length === 0;
  return (
    <section className={`inspection tools-column${parked ? ' parked' : ''}`} aria-label="Tools" aria-hidden={parked || undefined} style={{ width }}>
      {!parked && <ResizeEdge width={width} limits={PANE_WIDTH} onResize={tabActions.setPaneWidth} label="Resize this column" />}
      <div className="tool-stack" ref={box}>
        {STACK_ORDER.filter((p) => mounted.has(p)).map((pane) => {
          const at = stack.indexOf(pane);
          const visible = at !== -1;
          return (
            <div key={pane} className={`stack-pane${visible ? '' : ' off'}${at > 0 ? ' below' : ''}`} style={visible ? { flexGrow: shares[at] } : undefined} aria-label={LABEL[pane]} aria-hidden={visible ? undefined : true}>
              {at > 0 && <Divider kind={kind} stack={stack} index={at - 1} weights={weights} box={box} />}
              {render(pane, visible)}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** The line between two stacked panes: drag to move it, double-click to share the column evenly. */
function Divider({ kind, stack, index, weights, box }: { kind: ScopeKind; stack: readonly StackPane[]; index: number; weights: StackWeights; box: RefObject<HTMLDivElement | null> }) {
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const startY = event.clientY;
    const start = weights;
    const height = box.current?.getBoundingClientRect().height ?? 0;
    handle.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => tabActions.setStack(kind, dragDivider(stack, start, index, e.clientY - startY, height));
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  };
  const nudge = (dy: number) => tabActions.setStack(kind, dragDivider(stack, weights, index, dy, box.current?.getBoundingClientRect().height ?? 0));
  return (
    <div
      className="stack-divider"
      role="separator"
      aria-orientation="horizontal"
      aria-label={`Resize ${LABEL[stack[index]!]} and ${LABEL[stack[index + 1]!]}`}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => tabActions.setStack(kind, {})}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') nudge(-24);
        if (e.key === 'ArrowDown') nudge(24);
      }}
    />
  );
}
