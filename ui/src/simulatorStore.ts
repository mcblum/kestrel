// The simulator pane outside React. Its state lives in the app store's `simulator` slice (this module
// owns the writes): the device list, each session's chosen device, one device's
// screen and state, the live pictures, and the server's "show the Simulator view" calls. The
// server drives the simulator; this file only watches pictures (binary socket messages), sends the
// user's touches and key presses and calls the bar's routes. Message shapes are in @kestrel/server/simulator.
import { FRAME_MARK, UDID_LENGTH, type Edge, type KeyStep, type Orientation, type SimButton, type SimCapabilities, type SimDevice, type SimScreen } from '@kestrel/server/simulator';
import { appStore, call, setApp, simulatorSocket, useApp, type SocketMessage } from './store.ts';

export interface DeviceList {
  loaded: boolean;
  devices: readonly SimDevice[];
  /** Why there is no simulator at all (not a Mac, no Xcode). */
  unavailable: string | null;
}

export interface DeviceInfo {
  screen: SimScreen | null;
  orientation: Orientation;
  /** Why touches cannot reach this device, or null. */
  touch: string | null;
  /** What its input can do (null until booted and the helper answered). */
  capabilities: SimCapabilities | null;
  appearance: 'light' | 'dark' | 'unknown';
}

/** The simulator's slice of the app store (`simulator`). This module owns its writes. */
export interface SimulatorState {
  devices: DeviceList;
  infos: ReadonlyMap<string, DeviceInfo>;
  /** Each session's chosen device. */
  chosen: ReadonlyMap<string, string>;
  /** The latest problem per device (the picture stopped, a touch failed), until the next picture. */
  errors: ReadonlyMap<string, string>;
}
const sim = (): SimulatorState => appStore.get().simulator;
const setSim = (patch: Partial<SimulatorState>) => setApp({ simulator: { ...sim(), ...patch } });
/** Devices whose note is the server saying the picture stopped: dropped once the device is known to be shut down. */
const pictureStopped = new Set<string>();
export const useDevices = (): DeviceList => useApp((s) => s.simulator.devices);
export const useDeviceInfo = (udid: string | null): DeviceInfo | null => useApp((s) => (udid ? (s.simulator.infos.get(udid) ?? null) : null));
export const useChosen = (sessionId: string): string | null => useApp((s) => s.simulator.chosen.get(sessionId) ?? null);
export const useSimError = (udid: string | null): string | null => useApp((s) => (udid ? (s.simulator.errors.get(udid) ?? null) : null));

let loading: Promise<void> | null = null;
function loadDevices(): Promise<void> {
  loading ??= call<{ devices: SimDevice[]; unavailable?: string }>('/api/simulator')
    .then(
      (r) => {
        setSim({ devices: { loaded: true, devices: r.devices, unavailable: r.unavailable ?? null } });
        // The pane says "Boot a simulator" for those itself.
        for (const d of r.devices) if (d.state !== 'Booted' && pictureStopped.has(d.udid)) setError(d.udid, null);
      },
      (error: unknown) => setSim({ devices: { loaded: true, devices: [], unavailable: error instanceof Error ? error.message : String(error) } }),
    )
    .finally(() => {
      loading = null;
    });
  return loading;
}

async function loadInfo(udid: string): Promise<void> {
  try {
    const r = await call<DeviceInfo>(`/api/simulator/${udid}`);
    setSim({ infos: new Map(sim().infos).set(udid, { screen: r.screen, orientation: r.orientation, touch: r.touch, capabilities: r.capabilities ?? null, appearance: r.appearance }) });
  } catch (error) {
    setError(udid, error instanceof Error ? error.message : String(error));
  }
}

function setError(udid: string, message: string | null): void {
  pictureStopped.delete(udid);
  if ((sim().errors.get(udid) ?? null) === message) return;
  const next = new Map(sim().errors);
  if (message) next.set(udid, message);
  else next.delete(udid);
  setSim({ errors: next });
}

// ---- pictures -------------------------------------------------------------------------------

type FrameListener = (frame: ImageBitmap) => void;
const viewers = new Map<string, Set<{ listener: FrameListener; width: number }>>();
const sentWidth = new Map<string, number>();
const decoder = new TextDecoder();

function sendWatch(udid: string): void {
  const set = viewers.get(udid);
  if (!set?.size) {
    sentWidth.delete(udid);
    simulatorSocket.send({ type: 'sim-unwatch', udid });
    return;
  }
  const width = Math.max(...[...set].map((v) => v.width));
  if (sentWidth.get(udid) === width) return;
  if (simulatorSocket.send({ type: 'sim-watch', udid, maxWidth: width })) sentWidth.set(udid, width);
}

function receiveFrame(data: ArrayBuffer): void {
  const bytes = new Uint8Array(data);
  if (bytes.length <= 1 + UDID_LENGTH || bytes[0] !== FRAME_MARK) return;
  const udid = decoder.decode(bytes.subarray(1, 1 + UDID_LENGTH));
  const set = viewers.get(udid);
  if (!set?.size) return;
  createImageBitmap(new Blob([bytes.subarray(1 + UDID_LENGTH)], { type: 'image/jpeg' })).then(
    (bitmap) => set.forEach((v) => v.listener(bitmap)),
    () => undefined, // a picture that does not decode is skipped; the next one replaces it
  );
}

/** Reveal handlers per session, newest last: the window showing the session brings up its Simulator view. */
const reveals = new Map<string, readonly (() => void)[]>();

function receive(m: SocketMessage): void {
  const udid = typeof m.udid === 'string' ? m.udid : '';
  if (m.type === 'sim-show' && udid) {
    simulator.choose(m.sessionId, udid, false);
    reveals.get(m.sessionId)?.at(-1)?.();
    void loadDevices().then(() => loadInfo(udid));
  } else if (m.type === 'sim-changed') {
    void loadDevices();
    if (udid && sim().infos.has(udid)) void loadInfo(udid);
  } else if (m.type === 'sim-error' && udid) {
    sentWidth.delete(udid); // the server may have stopped the picture; dismissing the note asks again
    setError(udid, typeof m.error === 'string' ? m.error : 'The simulator could not do that.');
    pictureStopped.add(udid);
    void loadDevices();
  }
}

simulatorSocket.register({
  message: receive,
  binary: receiveFrame,
  opened: () => {
    sentWidth.clear();
    [...viewers.keys()].forEach(sendWatch);
    [...sim().chosen].forEach(([sessionId, udid]) => simulatorSocket.send({ type: 'sim-select', sessionId, udid }));
  },
});

// ---- the API the pane uses ------------------------------------------------------------------

const post = (udid: string, what: string, body: object = {}) => call<unknown>(`/api/simulator/${udid}/${what}`, { method: 'POST', body: JSON.stringify(body) });

export const simulator = {
  loadDevices,
  loadInfo,
  /** Dismiss the note under the bar, and ask for the picture again in case it had stopped. */
  clearError(udid: string): void {
    setError(udid, null);
    if (viewers.has(udid)) sendWatch(udid);
  },

  /** The device a session's pane shows; the agent's tools use it too (told to the server unless it came from there). */
  choose(sessionId: string, udid: string, tellServer = true): void {
    if (sim().chosen.get(sessionId) !== udid) setSim({ chosen: new Map(sim().chosen).set(sessionId, udid) });
    if (tellServer) simulatorSocket.send({ type: 'sim-select', sessionId, udid });
  },

  /** A session's workspace is on screen; `reveal` opens its Simulator view. Returns the function to call when it leaves. */
  serve(sessionId: string, reveal: () => void): () => void {
    reveals.set(sessionId, [...(reveals.get(sessionId) ?? []), reveal]);
    return () => {
      const rest = (reveals.get(sessionId) ?? []).filter((r) => r !== reveal);
      if (rest.length) reveals.set(sessionId, rest);
      else reveals.delete(sessionId);
    };
  },

  /** Watch a device's pictures at most `width` pixels wide. Returns the function that stops. */
  watch(udid: string, width: number, listener: FrameListener): () => void {
    const viewer = { listener, width: Math.max(100, Math.min(2400, Math.round(width))) };
    const set = viewers.get(udid) ?? new Set();
    set.add(viewer);
    viewers.set(udid, set);
    sendWatch(udid);
    return () => {
      set.delete(viewer);
      if (!set.size) viewers.delete(udid);
      sendWatch(udid);
    };
  },

  /** One finger (two with `second`: the Option-drag pinch), in device portrait points. */
  touch(udid: string, phase: 'down' | 'move' | 'up', x: number, y: number, extra: { second?: { x: number; y: number }; edge?: Edge } = {}): void {
    const second = extra.second ? { x2: extra.second.x, y2: extra.second.y } : {};
    simulatorSocket.send({ type: 'sim-touch', udid, phase, x, y, ...second, ...(extra.edge ? { edge: extra.edge } : {}) });
  },

  /** Key presses typed with the picture focused. */
  keys(udid: string, steps: KeyStep[]): void {
    simulatorSocket.send({ type: 'sim-keys', udid, steps });
  },

  async run(udid: string, what: () => Promise<unknown>): Promise<void> {
    try {
      await what();
      setError(udid, null);
    } catch (error) {
      setError(udid, error instanceof Error ? error.message : String(error));
    }
  },

  boot: (udid: string) => simulator.run(udid, () => post(udid, 'boot')),
  home: (udid: string) => simulator.run(udid, () => post(udid, 'home')),
  button: (udid: string, button: SimButton) => simulator.run(udid, () => post(udid, 'button', { button })),
  shake: (udid: string) => simulator.run(udid, () => post(udid, 'shake')),
  rotate: (udid: string, direction: 'left' | 'right') =>
    simulator.run(udid, async () => {
      const r = (await post(udid, 'rotate', { direction })) as { orientation: Orientation };
      const info = sim().infos.get(udid);
      if (info) setSim({ infos: new Map(sim().infos).set(udid, { ...info, orientation: r.orientation }) });
    }),
  appearance: (udid: string, mode: 'light' | 'dark') =>
    simulator.run(udid, async () => {
      await post(udid, 'appearance', { mode });
      const info = sim().infos.get(udid);
      if (info) setSim({ infos: new Map(sim().infos).set(udid, { ...info, appearance: mode }) });
    }),
  openApp: (udid: string) => simulator.run(udid, () => post(udid, 'open-app')),
  screenshot: (udid: string, sessionId: string) => simulator.run(udid, () => post(udid, 'screenshot', { sessionId })),
  /** Show a note under the bar (a keyboard press, say) until it is dismissed or the next action works. */
  note: (udid: string, text: string) => setError(udid, text),
};
