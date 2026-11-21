// The user's input on the simulator picture: pointer (click = tap, hold = long-press, drag = swipe,
// Option-drag = two fingers around the centre), trackpad scrolling (a drag at the pointer) and keys
// (with the picture focused, everything but Kestrel's own shortcuts goes to the device). The rules
// for keys and gestures are shared with the server (@kestrel/server/simulator) and tested there.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { cannot, edgeOf, keyForDevice, mirrored, pointerToDevice, shownSize, toDevicePoint, type Edge, type Orientation, type SimScreen } from '@kestrel/server/simulator';
import { simulator, type DeviceInfo } from '../simulatorStore.ts';

/** Finger reports at most this often, as a finger on glass (and SimulatorKit drops drags closer than 16 ms). */
const MOVE_EVERY_MS = 17;
/** A press within this many CSS pixels of the picture's border starts at the border: an edge gesture. */
const EDGE_SNAP_PX = 8;
/** Scrolling stops (the finger lifts) this long after the last wheel event. */
const WHEEL_END_MS = 120;
/** Wheel deltas in lines (a mouse wheel) are about this many pixels each. */
const LINE_PX = 16;

type Box = { width: number; height: number };
type Point = { x: number; y: number };

const boxOf = (el: Element): DOMRect => el.getBoundingClientRect();

/** The pointer in the picture, snapped to the border when close to it. Null outside. */
function offsetIn(e: { clientX: number; clientY: number }, box: DOMRect, snap: boolean): Point | null {
  const snapTo = (v: number, max: number) => (!snap ? v : v < EDGE_SNAP_PX ? 0 : v > max - EDGE_SNAP_PX ? max : v);
  const x = e.clientX - box.left;
  const y = e.clientY - box.top;
  if (x < 0 || y < 0 || x > box.width || y > box.height) return null;
  return { x: snapTo(x, box.width), y: snapTo(y, box.height) };
}

/** Why the pane cannot do this on this device, shown as a note; null when it can. */
function refuse(udid: string, info: DeviceInfo | null, need: Parameters<typeof cannot>[1]): boolean {
  if (!info?.screen) return true;
  // A server from before capabilities took one finger only.
  const old = need === 'touch' ? info.touch : 'Not available from this Kestrel server: restart it to get the newer simulator input.';
  const reason = info.capabilities ? cannot(info.capabilities, need) : old;
  if (reason) simulator.note(udid, reason);
  return Boolean(reason);
}

/** Pointer on the picture -> touches. `twoFingers` reports where the Option-drag fingers are, for the dots. */
export function usePointer(udid: string, info: DeviceInfo | null) {
  const touching = useRef<{ edge?: Edge; two: boolean } | null>(null);
  const lastMove = useRef(0);
  const deviceAt = (p: Point, box: Box, screen: SimScreen, orientation: Orientation) => pointerToDevice(p.x, p.y, box, screen, orientation);
  const send = (phase: 'down' | 'move' | 'up', p: Point, box: Box) => {
    const screen = info?.screen;
    const t = touching.current;
    if (!screen || !info || !t) return;
    const one = deviceAt(p, box, screen, info.orientation);
    if (!one) return;
    simulator.touch(udid, phase, one.x, one.y, { edge: t.edge, second: t.two ? mirrored(one, screen) : undefined });
  };
  return {
    down(e: ReactPointerEvent<HTMLElement>) {
      if (e.button !== 0) return;
      e.currentTarget.focus();
      const two = e.altKey;
      if (refuse(udid, info, two ? 'multitouch' : 'touch') || !info?.screen) return;
      const box = boxOf(e.currentTarget);
      const p = offsetIn(e, box, !two);
      if (!p) return;
      const start = deviceAt(p, box, info.screen, info.orientation);
      if (!start) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      touching.current = { edge: two ? undefined : edgeOf(start, info.screen), two };
      lastMove.current = e.timeStamp;
      send('down', p, box);
    },
    move(e: ReactPointerEvent<HTMLElement>) {
      if (!touching.current || e.timeStamp - lastMove.current < MOVE_EVERY_MS) return;
      const box = boxOf(e.currentTarget);
      const p = offsetIn(e, box, false);
      if (!p) return;
      lastMove.current = e.timeStamp;
      send('move', p, box);
    },
    up(e: ReactPointerEvent<HTMLElement>) {
      if (!touching.current) return;
      const box = boxOf(e.currentTarget);
      // Let go outside the picture: the touch ends at its nearest edge.
      send('up', { x: Math.min(Math.max(e.clientX - box.left, 0), box.width), y: Math.min(Math.max(e.clientY - box.top, 0), box.height) }, box);
      touching.current = null;
    },
  };
}

/**
 * Where the two fingers of an Option-drag would land, in CSS pixels of the picture, while Option is
 * held over it: the pointer and its mirror through the centre. Null otherwise.
 */
export function useTwoFingerDots(enabled: boolean) {
  const [dots, setDots] = useState<{ one: Point; two: Point } | null>(null);
  const hover = useRef<{ p: Point; box: Box } | null>(null);
  const alt = useRef(false);
  const show = () => {
    const h = hover.current;
    setDots(enabled && alt.current && h ? { one: h.p, two: { x: h.box.width - h.p.x, y: h.box.height - h.p.y } } : null);
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Alt' || alt.current === e.altKey) return;
      alt.current = e.altKey;
      show();
    };
    window.addEventListener('keydown', key);
    window.addEventListener('keyup', key);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('keyup', key);
    };
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return {
    dots,
    move(e: ReactPointerEvent<HTMLElement>) {
      const box = boxOf(e.currentTarget);
      const p = offsetIn(e, box, false);
      hover.current = p ? { p, box: { width: box.width, height: box.height } } : null;
      alt.current = e.altKey;
      show();
    },
    leave() {
      hover.current = null;
      show();
    },
  };
}

/** Two-finger trackpad scrolling over the picture: a finger put down at the pointer and dragged along. */
export function useWheel(udid: string, info: DeviceInfo | null) {
  const finger = useRef<{ shown: Point; lastSent: number; end: ReturnType<typeof setTimeout> | null } | null>(null);
  const lift = () => {
    const f = finger.current;
    finger.current = null;
    if (!f || !info?.screen) return;
    if (f.end) clearTimeout(f.end);
    const p = toDevicePoint(f.shown.x, f.shown.y, info.screen, info.orientation);
    simulator.touch(udid, 'up', p.x, p.y);
  };
  useEffect(() => () => lift(), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (e: ReactWheelEvent<HTMLElement>) => {
    if (e.ctrlKey || !info?.screen || !info.capabilities?.touch) return;
    const screen = info.screen;
    const shown = shownSize(screen, info.orientation);
    const box = boxOf(e.currentTarget);
    const perPx = shown.width / box.width;
    const unit = e.deltaMode === 1 ? LINE_PX : 1;
    let f = finger.current;
    if (!f) {
      const p = offsetIn(e, box, false);
      if (!p) return;
      f = { shown: { x: p.x * perPx, y: p.y * perPx }, lastSent: 0, end: null };
      finger.current = f;
      const d = toDevicePoint(f.shown.x, f.shown.y, screen, info.orientation);
      simulator.touch(udid, 'down', d.x, d.y);
    }
    // Content follows the fingers: scrolling down (positive delta) pushes the finger up.
    const next = { x: f.shown.x - e.deltaX * unit * perPx, y: f.shown.y - e.deltaY * unit * perPx };
    const inside = next.x >= 1 && next.y >= 1 && next.x <= shown.width - 1 && next.y <= shown.height - 1;
    if (!inside) return lift();
    f.shown = next;
    if (e.timeStamp - f.lastSent >= MOVE_EVERY_MS) {
      f.lastSent = e.timeStamp;
      const d = toDevicePoint(next.x, next.y, screen, info.orientation);
      simulator.touch(udid, 'move', d.x, d.y);
    }
    if (f.end) clearTimeout(f.end);
    f.end = setTimeout(lift, WHEEL_END_MS);
  };
}

/** Keys with the picture focused: the device's, unless they are Kestrel's shortcuts. */
export function useKeys(udid: string, info: DeviceInfo | null) {
  return (e: ReactKeyboardEvent<HTMLElement>) => {
    const steps = keyForDevice(e);
    if (!steps) return;
    const typing = !info?.capabilities || info.capabilities.keyboard;
    // Without a keyboard on the device, Tab still moves focus around Kestrel.
    if (!typing && e.code === 'Tab') return;
    e.preventDefault();
    e.stopPropagation();
    if (refuse(udid, info, 'keyboard')) return;
    simulator.keys(udid, steps);
  };
}
