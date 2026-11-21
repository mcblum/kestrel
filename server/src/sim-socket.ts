// The simulator pane over one WebSocket: which devices the window watches (each picture goes out
// as a binary message), the user's touches and key presses, and the device the user picked for a
// pane's scope (shared/scope.ts). Only a session's pick reaches an agent: the tools look up the
// calling session's own key.
// Message shapes are in shared/simulator.ts.
import type { Simulator } from './simulator.ts';
import type { SimTools } from './sim-tools.ts';
import type { InputRequest } from './sim-input.ts';
import { FRAME_MARK, isKeySteps, isUdid, UDID_LENGTH, type Edge } from './shared/simulator.ts';
import { normalizeScopeKey } from './shared/scope.ts';

type InputRequestOf<Op extends InputRequest['op']> = Extract<InputRequest, { op: Op }>;
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const MAX_WATCHES = 4;
/** One key press with every modifier held is 10 steps; this leaves room and no more. */
const MAX_KEY_STEPS = 16;
/** Frames waiting in the socket's buffer beyond this are skipped: a slow window gets fewer, never older ones. */
const MAX_BUFFERED = 4 * 1024 * 1024;

export interface SimSocketSink {
  sendText(payload: object): void;
  sendBinary(data: Buffer): void;
  buffered(): number;
}

export interface SimConnection {
  message(m: Record<string, unknown>): void;
  close(): void;
}

export function simSocket(simulator: Simulator, tools: SimTools, sink: SimSocketSink): SimConnection {
  const watches = new Map<string, () => void>();

  const watch = (udid: string, maxWidth: number) => {
    watches.get(udid)?.();
    watches.delete(udid);
    if (watches.size >= MAX_WATCHES) return;
    const head = Buffer.alloc(1 + UDID_LENGTH);
    head[0] = FRAME_MARK;
    head.write(udid.toUpperCase(), 1, 'ascii');
    const stop = simulator.watch(
      udid,
      {
        frame: (jpeg) => {
          if (sink.buffered() <= MAX_BUFFERED) sink.sendBinary(Buffer.concat([head, jpeg]));
        },
        error: (reason) => {
          watches.delete(udid);
          sink.sendText({ type: 'sim-error', udid, error: reason });
        },
      },
      maxWidth,
    );
    watches.set(udid, stop);
  };

  const send = (udid: string, request: InputRequestOf<'touch' | 'keys'>, quiet: boolean) =>
    void simulator.send(udid, request).then(
      (outcome) => !outcome.ok && !quiet && sink.sendText({ type: 'sim-error', udid, error: outcome.error }),
      (error: unknown) => sink.sendText({ type: 'sim-error', udid, error: error instanceof Error ? error.message : String(error) }),
    );

  const touch = (m: Record<string, unknown>) => {
    const { udid, phase, x, y, x2, y2, edge } = m;
    if (!isUdid(udid) || (phase !== 'down' && phase !== 'move' && phase !== 'up') || !isNumber(x) || !isNumber(y)) return;
    const second = x2 === undefined && y2 === undefined ? {} : isNumber(x2) && isNumber(y2) ? { x2, y2 } : null;
    if (!second) return;
    const atEdge: { edge?: Edge } = edge === 'top' || edge === 'bottom' || edge === 'left' || edge === 'right' ? { edge } : {};
    // A failed move would repeat its error dozens of times: only downs and ups report.
    send(udid, { op: 'touch', phase, x, y, ...second, ...atEdge }, phase === 'move');
  };

  const keys = (m: Record<string, unknown>) => {
    if (!isUdid(m.udid) || !isKeySteps(m.steps, MAX_KEY_STEPS)) return;
    send(m.udid, { op: 'keys', steps: m.steps.map((s) => ({ usage: s.usage, down: s.down })) }, false);
  };

  return {
    message(m) {
      const udid = m.udid;
      if (m.type === 'sim-touch') return touch(m);
      if (m.type === 'sim-keys') return keys(m);
      if (!isUdid(udid)) return;
      if (m.type === 'sim-watch') return watch(udid, typeof m.maxWidth === 'number' ? m.maxWidth : 800);
      if (m.type === 'sim-unwatch') {
        watches.get(udid)?.();
        watches.delete(udid);
        return;
      }
      const scope = normalizeScopeKey(m.sessionId);
      if (m.type === 'sim-select' && scope) tools.choose(scope, udid);
    },
    close() {
      for (const stop of watches.values()) stop();
      watches.clear();
    },
  };
}

export const isSimMessage = (type: unknown): boolean => typeof type === 'string' && type.startsWith('sim-');
