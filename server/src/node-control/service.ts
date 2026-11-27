// The terminal's `kestrel-node start` and `kestrel-node stop`, through `systemctl --user` when the node is installed
// as a service, and over the socket when it was started by hand. What to do is decided purely (`startPlan`,
// `stopPlan`) from the unit's state and whether a node answers; carrying it out is the only part that runs programs.
import { execFile } from 'node:child_process';
import { NODE_UNIT_NAME, type ServiceState } from '../shared/node-service.ts';

export type StartPlan = { do: 'systemctl' } | { do: 'nothing'; text: string } | { do: 'refuse'; reason: string };

/** `start`: the service is the only thing it starts; a node run by hand is started with `kestrel-node run`. */
export function startPlan(service: ServiceState, nodeAnswers: boolean): StartPlan {
  if (service.manager === 'none') return { do: 'refuse', reason: 'There is no systemd user manager here, so there is no service to start. Run "kestrel-node run" (in tmux or screen to keep it running after you log out).' };
  if (!service.installed) return { do: 'refuse', reason: `${NODE_UNIT_NAME} is not installed. Run the install again to set it up, or start the node by hand with "kestrel-node run".` };
  if (service.active) return { do: 'nothing', text: `${NODE_UNIT_NAME} is running already.` };
  if (nodeAnswers) return { do: 'refuse', reason: 'A node started by hand is running here. Stop it ("kestrel-node stop") before starting the service.' };
  return { do: 'systemctl' };
}

export type StopPlan = { do: 'systemctl' } | { do: 'socket' } | { do: 'nothing'; text: string };

/** `stop`: through systemd when it runs the node (so it is not started again), else over the socket. */
export function stopPlan(service: ServiceState, nodeAnswers: boolean): StopPlan {
  if (service.manager === 'systemd' && service.installed && service.active) return { do: 'systemctl' };
  if (nodeAnswers) return { do: 'socket' };
  return { do: 'nothing', text: 'No worker node is running here.' };
}

/** Runs `systemctl --user <args…>`: whether it exited 0, and what it printed on stderr. */
export type Systemctl = (args: readonly string[]) => Promise<{ ok: boolean; error: string }>;

export const systemctl: Systemctl = (args) =>
  new Promise((resolve) =>
    // Stopping waits for the node's own shutdown (TimeoutStopSec), so this is given longer than that.
    execFile('systemctl', ['--user', ...args], { timeout: 120_000, encoding: 'utf8' }, (error, _stdout, stderr) => resolve({ ok: !error, error: (stderr || (error ? error.message : '')).trim() })),
  );

/** `systemctl --user start|stop` on the unit, worded for the terminal. */
export async function unitAction(action: 'start' | 'stop', run: Systemctl = systemctl): Promise<{ ok: boolean; line: string }> {
  const done = await run([action, NODE_UNIT_NAME]);
  if (!done.ok) return { ok: false, line: `systemctl --user ${action} ${NODE_UNIT_NAME} failed${done.error ? `: ${done.error}` : '.'}` };
  return { ok: true, line: action === 'start' ? `Started ${NODE_UNIT_NAME}. "kestrel-node status" says how it is.` : `Stopped ${NODE_UNIT_NAME}.` };
}
