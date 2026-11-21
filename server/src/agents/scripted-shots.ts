// The scripted agent's "/shots N": a turn that tests an app the way a real agent does, taking N
// screenshots with a tap between each, so grouped pictures can be seen with realistic data. The
// pictures are the PNG/JPEG files in KESTREL_SCRIPTED_PICTURES (taken in turn), else drawn SVGs that
// alternate between a phone (portrait) and a browser window (wide). Fake data only.
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { AgentEvent } from './types.ts';

const STEP_MS = 1200;
const MAX_SHOTS = 60;
const FILE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

interface Picture {
  mediaType: string;
  data: string;
}

/** A made-up screenshot: mostly a phone, every third a browser window, every seventh a very wide one. */
export function drawnPicture(n: number): Picture {
  const wide = n % 3 === 2 || n % 7 === 6;
  const [w, h] = n % 7 === 6 ? [2560, 720] : wide ? [1280, 800] : [402, 874];
  const hue = (n * 47) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="hsl(${hue} 30% 85%)"/><rect x="24" y="24" width="${w - 48}" height="${h - 48}" rx="24" fill="hsl(${hue} 25% 96%)"/><text x="50%" y="50%" font-family="-apple-system, sans-serif" font-size="${wide ? 64 : 44}" text-anchor="middle" fill="#333">${wide ? 'Browser' : 'Simulator'} ${n + 1}</text></svg>`;
  return { mediaType: 'image/svg+xml', data: Buffer.from(svg).toString('base64') };
}

function fromFolder(): Picture[] {
  const dir = process.env.KESTREL_SCRIPTED_PICTURES;
  if (!dir) return [];
  try {
    return readdirSync(dir)
      .filter((f) => FILE_TYPES[extname(f).toLowerCase()])
      .sort()
      .map((f) => ({ mediaType: FILE_TYPES[extname(f).toLowerCase()]!, data: readFileSync(join(dir, f)).toString('base64') }));
  } catch {
    return [];
  }
}

/** The events of a "/shots N" turn, each with its delay from the start. The caller emits them and ends the turn. */
export function shotsScript(count: number): { at: number; event: AgentEvent }[] {
  const n = Math.max(1, Math.min(MAX_SHOTS, count));
  const files = fromFolder();
  const out: { at: number; event: AgentEvent }[] = [];
  let at = 300;
  const add = (event: AgentEvent) => out.push({ at: (at += STEP_MS / 4), event });
  add({ type: 'message', id: `m-${randomUUID()}`, text: `Testing the app: ${n} screenshots.`, delta: '', done: true });
  for (let i = 0; i < n; i++) {
    const tap = `tap-${randomUUID()}`;
    add({ type: 'tool', id: tap, name: 'mcp__kestrel__sim_tap', summary: `Tap (${100 + i * 7}, ${300 + i * 11})`, status: 'started' });
    add({ type: 'tool', id: tap, name: 'mcp__kestrel__sim_tap', summary: `Tap (${100 + i * 7}, ${300 + i * 11})`, status: 'finished' });
    const shot = `shot-${randomUUID()}`;
    add({ type: 'tool', id: shot, name: 'mcp__kestrel__sim_screenshot', summary: 'Screenshot of the simulator', status: 'started' });
    const picture = files.length ? files[i % files.length]! : drawnPicture(i);
    add({ type: 'image', id: `${shot}-0`, ...picture });
    add({ type: 'tool', id: shot, name: 'mcp__kestrel__sim_screenshot', summary: 'Screenshot of the simulator', status: 'finished' });
    at += STEP_MS;
  }
  add({ type: 'message', id: `m-${randomUUID()}`, text: 'All screens checked.', delta: '', done: true });
  return out;
}
