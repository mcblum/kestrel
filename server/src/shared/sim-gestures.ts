// Touch gestures as the simulator's digitizer takes them: a list of finger reports, each with the
// time to wait before it. Points come in as the picture shows them (upright) and go out in the
// device's portrait points. Pure, so the timing and the rotation maths are pinned by tests.
import { shownSize, toDevicePoint, type Orientation, type SimScreen } from './simulator.ts';

export type Edge = 'top' | 'bottom' | 'left' | 'right';
export type Phase = 'down' | 'move' | 'up';

/** One digitizer report: one or two fingers, in device portrait points, `wait` ms after the previous one. */
export interface TouchStep {
  phase: Phase;
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  edge?: Edge;
  wait: number;
}

export interface Point {
  x: number;
  y: number;
}

/** A report every 16 ms (60 Hz), as a finger on glass: enough points for iOS to see speed and inertia. */
export const STEP_MS = 16;
/** A press this long or longer is a long-press. */
export const LONG_PRESS_MS = 500;
export const TAP_MS = 60;
/** A swipe that starts this close to the screen's border starts at that edge (system gestures). */
export const EDGE_POINTS = 3;
export const PINCH_LIMITS = { scale: [0.2, 5], rotation: [-360, 360], duration: [100, 5000] } as const;

type Screen = Pick<SimScreen, 'width' | 'height'>;

const round = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Which border of the device (portrait frame) a point is on, if any. Bottom wins a corner: it is Home. */
export function edgeOf(p: Point, screen: Screen): Edge | undefined {
  if (p.y >= screen.height - EDGE_POINTS) return 'bottom';
  if (p.y <= EDGE_POINTS) return 'top';
  if (p.x <= EDGE_POINTS) return 'left';
  if (p.x >= screen.width - EDGE_POINTS) return 'right';
  return undefined;
}

const device = (p: Point, screen: Screen, orientation: Orientation): Point => {
  const d = toDevicePoint(p.x, p.y, screen, orientation);
  return { x: round(d.x), y: round(d.y) };
};

/** A tap, or a long-press when `holdMs` is LONG_PRESS_MS or more. */
export function tapGesture(at: Point, holdMs: number, screen: Screen, orientation: Orientation): TouchStep[] {
  const p = device(at, screen, orientation);
  return [
    { phase: 'down', ...p, wait: 0 },
    { phase: 'up', ...p, wait: Math.max(TAP_MS, Math.round(holdMs)) },
  ];
}

/** A straight swipe at a steady speed. One that starts at the screen's border is an edge gesture. */
export function swipeGesture(from: Point, to: Point, ms: number, screen: Screen, orientation: Orientation): TouchStep[] {
  const a = device(from, screen, orientation);
  const b = device(to, screen, orientation);
  const edge = edgeOf(a, screen);
  const count = Math.max(3, Math.round(ms / STEP_MS));
  const step = (phase: Phase, t: number, wait: number): TouchStep => ({ phase, x: round(a.x + (b.x - a.x) * t), y: round(a.y + (b.y - a.y) * t), ...(edge ? { edge } : {}), wait });
  const moves = Array.from({ length: count }, (_, i) => step('move', (i + 1) / count, Math.round(ms / count)));
  return [step('down', 0, 0), ...moves, step('up', 1, STEP_MS)];
}

/**
 * Two fingers around `center` (as shown): they start a little apart, end `scale` times as far apart
 * and turned by `rotationDeg`, positive clockwise as the user sees it. The turn is measured on the
 * upright picture and every point is then mapped to the device, so it reads the same in landscape.
 */
export function pinchGesture(center: Point, scale: number, rotationDeg: number, ms: number, screen: Screen, orientation: Orientation): TouchStep[] {
  const shown = shownSize(screen, orientation);
  const start = Math.min(shown.width, shown.height) * (scale >= 1 ? 0.1 : 0.3);
  const count = Math.max(3, Math.round(ms / STEP_MS));
  const inside = (p: Point): Point => ({ x: clamp(p.x, 1, shown.width - 1), y: clamp(p.y, 1, shown.height - 1) });
  // Asked to turn and spread, the fingers turn first and spread after, in one touch. Maps (iOS 27.2,
  // 2026-11) commits to zooming as soon as the fingers move apart and then ignores any turn: a
  // simultaneous 3x + 45 degrees only zoomed; this order did both.
  const both = scale !== 1 && rotationDeg !== 0;
  const turnAt = (t: number) => (both ? Math.min(1, 2 * t) : t);
  const spreadAt = (t: number) => (both ? Math.max(0, 2 * t - 1) : t);
  const at = (phase: Phase, t: number, wait: number): TouchStep => {
    const r = start * (1 + (scale - 1) * spreadAt(t));
    // Screen y grows downward, so a growing angle turns clockwise on screen.
    const angle = (rotationDeg * turnAt(t) * Math.PI) / 180;
    const dx = r * Math.cos(angle);
    const dy = r * Math.sin(angle);
    const one = device(inside({ x: center.x - dx, y: center.y - dy }), screen, orientation);
    const two = device(inside({ x: center.x + dx, y: center.y + dy }), screen, orientation);
    return { phase, x: one.x, y: one.y, x2: two.x, y2: two.y, wait };
  };
  const moves = Array.from({ length: count }, (_, i) => at('move', (i + 1) / count, Math.round(ms / count)));
  return [at('down', 0, 0), ...moves, at('up', 1, STEP_MS)];
}

/** The second finger of the pane's Option-drag: the first one mirrored through the centre of the screen. */
export function mirrored(p: Point, screen: Screen): Point {
  return { x: round(screen.width - p.x), y: round(screen.height - p.y) };
}

/** How long a gesture takes, start to finish. */
export const gestureMs = (steps: readonly { wait: number }[]) => steps.reduce((sum, s) => sum + s.wait, 0);
