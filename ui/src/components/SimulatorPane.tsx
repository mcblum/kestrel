// A scope's iOS Simulator (a session's, a project page's, a group page's): one line of controls (device, Home, Lock, rotate, appearance, a
// picture into the conversation, more: volume, Siri, shake; Simulator.app) over the device's live
// screen. The user taps, holds, drags, scrolls, Option-drags (two fingers) and, with the picture
// focused, types on it (simInput.ts); a session's agent drives the same device through Kestrel's
// sim_ tools. The column has its own width (phone-wide to start). Turned off, it stays mounted out
// of sight and stops asking for pictures. The server does the work (server/src/simulator.ts); this
// file draws pictures and the controls.
import { memo, useEffect, useRef, useState } from 'react';
import { PaneClose, PaneHead } from './PaneHead.tsx';
import { Camera, Circle, ExternalLink, Lock, Moon, RotateCcw, RotateCw, Smartphone, Sun, X } from 'lucide-react';
import { cannot, deviceLabel, NO_SIMULATORS, shownSize, type SimButton, type SimDevice } from '@kestrel/server/simulator';
import { SIM_WIDTH } from '@kestrel/server/pane-layout';
import { simulator, useChosen, useDeviceInfo, useDevices, useSimError, type DeviceInfo } from '../simulatorStore.ts';
import { tabActions } from '../tabsStore.ts';
import { ResizeEdge } from './ResizeEdge.tsx';
import { SimMore } from './SimMore.tsx';
import { useKeys, usePointer, useTwoFingerDots, useWheel } from './simInput.ts';

/** iPhone screen corners are about an eighth of the short side. */
const CORNER = 0.12;
/** The stage's padding (simulator-pane.css), kept clear around the picture. */
const STAGE_PAD = 12;

/** Why a hardware button cannot be pressed on this device, or null. */
function buttonBlocked(info: DeviceInfo | null, button: SimButton): string | null {
  if (!info) return 'The simulator is not ready.';
  if (info.capabilities) return cannot(info.capabilities, { button });
  // A server from before capabilities: Home was all it could press.
  return button === 'home' ? info.touch : 'Not available from this Kestrel server: restart it to get the newer simulator input.';
}

/** `sessionId` is set on a session's page: only there can a picture go into a conversation. */
export function SimulatorColumn({ scopeKey, sessionId, visible, width }: { scopeKey: string; sessionId: string | null; visible: boolean; width: number }) {
  return (
    <section className={`inspection simulator-column${visible ? '' : ' parked'}`} aria-label="Simulator" aria-hidden={visible ? undefined : true} style={{ width }}>
      {visible && <ResizeEdge width={width} limits={SIM_WIDTH} onResize={tabActions.setSimWidth} label="Resize the simulator column" />}
      <SimulatorPane scopeKey={scopeKey} sessionId={sessionId} visible={visible} />
    </section>
  );
}

function SimulatorPane({ scopeKey, sessionId, visible }: { scopeKey: string; sessionId: string | null; visible: boolean }) {
  const list = useDevices();
  const picked = useChosen(scopeKey);
  const [booting, setBooting] = useState<string | null>(null);

  useEffect(() => {
    if (visible) void simulator.loadDevices();
  }, [visible]);

  // With nothing picked yet, the pane shows the first booted device.
  const device = list.devices.find((d) => d.udid === picked) ?? list.devices.find((d) => d.state === 'Booted') ?? null;
  const live = device?.state === 'Booted' ? device : null;
  useEffect(() => {
    if (live && visible) void simulator.loadInfo(live.udid);
  }, [live?.udid, visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (udid: string) => {
    simulator.choose(scopeKey, udid);
    const target = list.devices.find((d) => d.udid === udid);
    if (target && target.state !== 'Booted') void boot(udid);
  };
  const boot = async (udid: string) => {
    setBooting(udid);
    await simulator.boot(udid);
    await simulator.loadDevices();
    setBooting(null);
  };

  // Nothing to control yet, so no bar: a plain head carries the X.
  const bare = (text: string) => (
    <>
      <PaneHead pane="simulator" name="Simulator" />
      <p className="sim-empty">{text}</p>
    </>
  );
  if (!list.loaded) return bare('Looking for simulators…');
  if (list.unavailable) return bare(list.unavailable);
  if (!list.devices.length) return bare(NO_SIMULATORS);

  return (
    <div className="sim-view">
      <SimBar sessionId={sessionId} devices={list.devices} device={device} live={live} onChoose={choose} />
      {live && booting !== live.udid ? (
        <Screen key={live.udid} udid={live.udid} watching={visible} />
      ) : booting ? (
        <p className="sim-empty">Booting {list.devices.find((d) => d.udid === booting)?.name ?? 'the simulator'}…</p>
      ) : (
        <div className="sim-empty">
          <span>{device ? 'Boot a simulator to see it here.' : 'Boot a simulator to see it here: pick one above.'}</span>
          {device && (
            <button type="button" className="sim-boot" onClick={() => void boot(device.udid)}>
              Boot {device.name}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const SimBar = memo(function SimBar({ sessionId, devices, device, live, onChoose }: { sessionId: string | null; devices: readonly SimDevice[]; device: SimDevice | null; live: SimDevice | null; onChoose: (udid: string) => void }) {
  const info = useDeviceInfo(live?.udid ?? null);
  const note = useSimError(device?.udid ?? null);
  const udid = live?.udid;
  const dark = info?.appearance === 'dark';
  // A turn can take seconds (devicectl's first call starts CoreDevice): the buttons say so and wait.
  const [turning, setTurning] = useState(false);
  const turn = async (direction: 'left' | 'right') => {
    if (!udid || turning) return;
    setTurning(true);
    try {
      await simulator.rotate(udid, direction);
    } finally {
      setTurning(false);
    }
  };
  const rotateBlocked = info?.capabilities ? cannot(info.capabilities, 'rotate') : null;
  const rotateLabel = (side: string) => (rotateBlocked ? `Rotate ${side}: ${rotateBlocked}` : turning ? 'Turning the device…' : `Rotate ${side}`);
  const homeBlocked = buttonBlocked(info, 'home');
  const lockBlocked = buttonBlocked(info, 'lock');
  return (
    <>
      <div className="sim-bar">
        <label className="sim-device" title="Device">
          <Smartphone aria-hidden />
          <select aria-label="Device" value={device?.udid ?? ''} onChange={(e) => onChoose(e.target.value)}>
            {!device && <option value="">Choose a simulator</option>}
            {devices.map((d) => (
              <option key={d.udid} value={d.udid}>
                {deviceLabel(d)}
                {d.state === 'Booted' ? ' (booted)' : ''}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="sim-button" aria-label={homeBlocked ? `Home: ${homeBlocked}` : 'Home'} disabled={!udid || Boolean(homeBlocked)} onClick={() => udid && void simulator.button(udid, 'home')}>
          <Circle aria-hidden />
        </button>
        <button type="button" className="sim-button" aria-label={lockBlocked ? `Lock: ${lockBlocked}` : 'Lock (side button)'} disabled={!udid || Boolean(lockBlocked)} onClick={() => udid && void simulator.button(udid, 'lock')}>
          <Lock aria-hidden />
        </button>
        <button type="button" className="sim-button" aria-label={rotateLabel('left')} aria-busy={turning} disabled={!udid || turning || Boolean(rotateBlocked)} onClick={() => void turn('left')}>
          <RotateCcw aria-hidden />
        </button>
        <button type="button" className="sim-button" aria-label={rotateLabel('right')} aria-busy={turning} disabled={!udid || turning || Boolean(rotateBlocked)} onClick={() => void turn('right')}>
          <RotateCw aria-hidden />
        </button>
        <button type="button" className="sim-button" aria-label={dark ? 'Switch to light appearance' : 'Switch to dark appearance'} aria-pressed={dark} disabled={!udid || !info} onClick={() => udid && void simulator.appearance(udid, dark ? 'light' : 'dark')}>
          {dark ? <Moon aria-hidden /> : <Sun aria-hidden />}
        </button>
        <button type="button" className="sim-button" aria-label={sessionId ? 'Put a screenshot into the conversation' : 'Screenshots go into a session’s conversation: open the simulator from a session'} disabled={!udid || !sessionId} onClick={() => udid && sessionId && void simulator.screenshot(udid, sessionId)}>
          <Camera aria-hidden />
        </button>
        <SimMore udid={udid} capabilities={info?.capabilities ?? null} />
        <span className="sim-spacer" />
        <button type="button" className="sim-button" aria-label="Open Simulator.app" disabled={!device} onClick={() => device && void simulator.openApp(device.udid)}>
          <ExternalLink aria-hidden />
        </button>
        <PaneClose pane="simulator" name="Simulator" />
      </div>
      {note && device && (
        <p className="sim-note">
          <span>{note}</span>
          <button type="button" className="sim-button" aria-label="Dismiss" onClick={() => simulator.clearError(device.udid)}>
            <X aria-hidden />
          </button>
        </p>
      )}
    </>
  );
});

/** The live picture, fitted to the column, and the user's touches on it. Pictures are asked for only while `watching`. */
function Screen({ udid, watching }: { udid: string; watching: boolean }) {
  const info = useDeviceInfo(udid);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [room, setRoom] = useState<{ width: number; height: number } | null>(null);
  const [frame, setFrame] = useState<{ width: number; height: number } | null>(null);

  // The room the picture has, in CSS pixels.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setRoom({ width: el.clientWidth - 2 * STAGE_PAD, height: el.clientHeight - 2 * STAGE_PAD }));
    observer.observe(el, { box: 'border-box' });
    return () => observer.disconnect();
  }, []);

  const fit = fitted(room, frame, info);
  // Ask for pictures as wide as they are drawn, in device pixels, in steps so a resize does not re-ask every pixel.
  const wanted = fit ? Math.ceil((fit.width * window.devicePixelRatio) / 100) * 100 : 800;

  useEffect(() => {
    if (!watching) return;
    let last: ImageBitmap | null = null;
    const stop = simulator.watch(udid, wanted, (bitmap) => {
      const el = canvas.current;
      if (!el) return bitmap.close();
      if (el.width !== bitmap.width || el.height !== bitmap.height) {
        el.width = bitmap.width;
        el.height = bitmap.height;
      }
      el.getContext('2d')?.drawImage(bitmap, 0, 0);
      setFrame((f) => (f && f.width === bitmap.width && f.height === bitmap.height ? f : { width: bitmap.width, height: bitmap.height }));
      last?.close();
      last = bitmap;
    });
    return () => {
      stop();
      last?.close();
    };
  }, [udid, wanted, watching]);

  const pointer = usePointer(udid, info);
  const fingers = useTwoFingerDots(Boolean(info?.capabilities?.multitouch));
  const wheel = useWheel(udid, info);
  const onKeyDown = useKeys(udid, info);
  const viewOnly = info?.capabilities ? cannot(info.capabilities, 'touch') : info?.touch;

  return (
    <div className="sim-stage" ref={stage}>
      <div className="sim-frame" style={fit ? { width: fit.width, height: fit.height } : { visibility: 'hidden' }}>
        <canvas
          ref={canvas}
          className={`sim-screen${viewOnly ? ' view-only' : ''}`}
          tabIndex={0}
          aria-label={viewOnly ? `Simulator screen (view only: ${viewOnly})` : 'Simulator screen: click to tap, hold to long-press, drag to swipe, Option-drag to pinch and turn; once clicked, typing goes to the device'}
          style={fit ? { borderRadius: Math.min(fit.width, fit.height) * CORNER } : undefined}
          onPointerDown={pointer.down}
          onPointerMove={(e) => {
            pointer.move(e);
            fingers.move(e);
          }}
          onPointerUp={pointer.up}
          onPointerCancel={pointer.up}
          onPointerLeave={fingers.leave}
          onWheel={wheel}
          onKeyDown={onKeyDown}
        />
        {fingers.dots && (
          <>
            <span className="sim-finger" style={{ left: fingers.dots.one.x, top: fingers.dots.one.y }} />
            <span className="sim-finger" style={{ left: fingers.dots.two.x, top: fingers.dots.two.y }} />
          </>
        )}
      </div>
      {!frame && <p className="sim-empty overlay">Waiting for the screen…</p>}
    </div>
  );
}

/** The picture's drawn size: as large as fits, keeping the device's shape. */
function fitted(room: { width: number; height: number } | null, frame: { width: number; height: number } | null, info: DeviceInfo | null): { width: number; height: number } | null {
  if (!room || room.width <= 0 || room.height <= 0) return null;
  const shape = frame ?? (info?.screen ? shownSize(info.screen, info.orientation) : null);
  if (!shape) return null;
  const scale = Math.min(room.width / shape.width, room.height / shape.height);
  return { width: Math.floor(shape.width * scale), height: Math.floor(shape.height * scale) };
}
