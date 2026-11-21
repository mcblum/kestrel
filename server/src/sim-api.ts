// The simulator pane's HTTP routes, under /api/simulator: the devices, one device's screen and
// state and what its input can do, and the bar's buttons (hardware buttons, shake, rotation, appearance). Touches and pictures go over the WebSocket (sim-socket.ts).
import type { SessionRuntime } from './runtime.ts';
import { cannot, isUdid, rotate, SIM_BUTTONS, type Orientation, type SimButton } from './shared/simulator.ts';
import { Refused } from './workspace.ts';

export type SimAnswer = { status: number; body?: unknown };
type ReadBody = () => Promise<Record<string, unknown>>;

const SHOT_WIDTH = 1200;

/** Answers a request whose path starts /api/simulator, or null when it is not one of these routes. */
export async function simRoute(parts: readonly string[], method: string, readBody: ReadBody, runtime: SessionRuntime): Promise<SimAnswer | null> {
  const sim = runtime.sim.simulator;
  if (parts[1] !== 'simulator') return null;
  if (method === 'GET' && parts.length === 2) {
    try {
      return { status: 200, body: { devices: await sim.devices() } };
    } catch (error) {
      if (error instanceof Refused) return { status: 200, body: { devices: [], unavailable: error.message } };
      throw error;
    }
  }
  const udid = parts[2];
  if (!isUdid(udid)) return null;
  if (method === 'GET' && parts.length === 3) {
    const device = await sim.find(udid);
    if (device.state !== 'Booted') return { status: 200, body: { device, screen: null, orientation: 1, capabilities: null, touch: null, appearance: 'unknown' } };
    // Which way the device is really turned, asked once in the background; a change reaches the pane as sim-changed.
    void sim.learnOrientation(udid);
    // The screen's size comes from the input helper; when it cannot start, the pane still shows the picture.
    const screen = await sim.screen(udid).then(
      (s) => ({ screen: s, screenError: null }),
      (e: unknown) => {
        if (e instanceof Refused) return { screen: null, screenError: e.message };
        throw e;
      },
    );
    const capabilities = await sim.capabilities(udid);
    const appearance = await sim.appearance(udid).catch(() => 'unknown');
    // `touch` (why touches cannot work, or null) is what panes before capabilities read.
    const touch = screen.screenError ?? cannot(capabilities, 'touch');
    return { status: 200, body: { device, screen: screen.screen, screenError: screen.screenError, orientation: sim.orientation(udid), capabilities, touch, appearance } };
  }
  if (method !== 'POST' || parts.length !== 4) return null;
  const body = await readBody();
  switch (parts[3]) {
    case 'boot':
      await sim.boot(udid);
      return { status: 204 };
    case 'home':
    case 'button': {
      const button = parts[3] === 'home' ? 'home' : body.button;
      if (!SIM_BUTTONS.includes(button as SimButton)) throw new Refused(`button must be one of ${SIM_BUTTONS.join(', ')}.`);
      const outcome = await sim.send(udid, { op: 'button', button: button as SimButton });
      if (!outcome.ok) throw new Refused(outcome.error);
      return { status: 204 };
    }
    case 'shake': {
      const outcome = await sim.send(udid, { op: 'shake' });
      if (!outcome.ok) throw new Refused(outcome.error);
      return { status: 204 };
    }
    case 'rotate': {
      if (body.direction !== 'left' && body.direction !== 'right') throw new Refused('direction must be left or right.');
      const next: Orientation = rotate(sim.orientation(udid), body.direction);
      await sim.rotate(udid, next);
      return { status: 200, body: { orientation: next } };
    }
    case 'appearance':
      if (body.mode !== 'light' && body.mode !== 'dark') throw new Refused('mode must be light or dark.');
      await sim.setAppearance(udid, body.mode);
      return { status: 204 };
    case 'open-app':
      await sim.openSimulatorApp(udid);
      return { status: 204 };
    case 'screenshot': {
      // The user's "picture into the conversation".
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      if (!sessionId || sessionId.length > 100) throw new Refused('sessionId is required.');
      const shot = await sim.screenshot(udid, SHOT_WIDTH);
      await runtime.showPicture(sessionId, { mediaType: shot.mediaType, data: shot.data.toString('base64') });
      return { status: 204 };
    }
    default:
      return null;
  }
}
