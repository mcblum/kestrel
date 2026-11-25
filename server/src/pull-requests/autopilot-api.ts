// POST /api/sessions/:id/autopilot {on, merge}: the request pill's menu and Session Details turn Autopilot on
// or off for the session's pull request, or change Merge when green while it is on (docs/designs/pr-autopilot.md).
// The phone's `autopilot.set` calls `setAutopilot` too, so both go one way.
import type { AutopilotRecord } from '../shared/autopilot.ts';
import { Refused } from '../refused.ts';
import type { Autopilot } from './autopilot.ts';

export interface AutopilotChange {
  on: boolean;
  merge?: boolean;
}

/** Checks a sent change strictly; a reason when it is not one. */
export function autopilotChange(raw: Record<string, unknown>): AutopilotChange | string {
  if (typeof raw.on !== 'boolean') return 'Say whether Autopilot is on (on: true or false).';
  if (raw.merge !== undefined && typeof raw.merge !== 'boolean') return 'Merge when green is true or false.';
  return { on: raw.on, ...(raw.merge === undefined ? {} : { merge: raw.merge }) };
}

/** Carries out a change: on (or Merge when green changed while on), or off. The record after, null once off. */
export async function setAutopilot(autopilot: Autopilot | null, sessionId: string, change: AutopilotChange): Promise<AutopilotRecord | null> {
  if (!autopilot) throw new Refused('Autopilot is not running yet: Kestrel has not started watching pull requests.');
  if (!change.on) {
    await autopilot.turnOff(sessionId);
    return null;
  }
  if (autopilot.isOn(sessionId) || autopilot.isArmed(sessionId)) return change.merge === undefined ? null : autopilot.setMerge(sessionId, change.merge);
  return autopilot.turnOn(sessionId, change.merge ?? false);
}

// With sample data it works too (the demo shows it), but never merges: runtime.ts refuses a sample merge.
export async function autopilotRoute(parts: readonly string[], method: string, read: () => Promise<Record<string, unknown>>, autopilot: Autopilot | null): Promise<{ status: number; body: unknown } | null> {
  if (method !== 'POST' || parts.length !== 4 || parts[1] !== 'sessions' || parts[3] !== 'autopilot') return null;
  const change = autopilotChange(await read());
  if (typeof change === 'string') return { status: 400, body: { error: change } };
  try {
    return { status: 200, body: { autopilot: await setAutopilot(autopilot, parts[2]!, change) } };
  } catch (error) {
    return { status: error instanceof Refused ? 409 : 400, body: { error: error instanceof Error ? error.message : String(error) } };
  }
}
