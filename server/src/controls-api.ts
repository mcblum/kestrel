// HTTP routes for the controls under the message box. Shaped like organize-api.ts: the caller hands
// over the path parts and gets an answer, or null.
//
//   GET /api/agents/:agent/capabilities   AgentCapabilities: models (effort, fast), permission levels, context usage
//   GET /api/sessions/:id/context         { usage: ContextUsage | null }
//
// `speedFields` reads effort and fast mode from a start or reply body.
import type { Agent } from './model.ts';
import type { SessionRuntime } from './runtime.ts';

export type ControlsAnswer = { status: number; body?: unknown };

const AGENTS: readonly string[] = ['claude', 'codex', 'opencode'];
const MAX_ID = 100;
/** Effort names are short words (`low`, `xhigh`); empty means the model's default. */
const EFFORT = /^[a-z]{0,16}$/;

export async function controlsRoute(parts: readonly string[], method: string, runtime: SessionRuntime | null): Promise<ControlsAnswer | null> {
  if (!runtime || method !== 'GET' || parts.length !== 4) return null;
  if (parts[1] === 'agents' && parts[3] === 'capabilities') {
    if (!AGENTS.includes(parts[2]!)) return { status: 404, body: { error: 'No such agent.' } };
    return { status: 200, body: await runtime.capabilities(parts[2] as Agent) };
  }
  if (parts[1] === 'sessions' && parts[3] === 'context') {
    const id = decodeURIComponent(parts[2]!);
    if (id.length > MAX_ID) return { status: 400, body: { error: 'id is too long' } };
    const shown = await runtime.contextShown(id);
    return { status: 200, body: { usage: shown.context, ...(shown.contextNote ? { note: shown.contextNote } : {}) } };
  }
  return null;
}

/** Effort and fast mode from a request body; a field that is absent stays absent. Throws a message for a bad value. */
export function speedFields(body: Record<string, unknown>): { effort?: string; fast?: boolean } {
  const out: { effort?: string; fast?: boolean } = {};
  if (body.effort !== undefined) {
    if (typeof body.effort !== 'string' || !EFFORT.test(body.effort)) throw new Error('effort must be a level name such as low, medium or high, or empty for the default');
    out.effort = body.effort;
  }
  if (body.fast !== undefined) {
    if (typeof body.fast !== 'boolean') throw new Error('fast must be true or false');
    out.fast = body.fast;
  }
  return out;
}
