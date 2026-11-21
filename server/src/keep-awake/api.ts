// HTTP route for Settings → Workflow → Keep awake (shared/keep-awake.ts). The UI's only.
//
//   GET /api/keep-awake                 200 KeepAwakeView { enabled, state, power }
//   PUT /api/keep-awake  { enabled }    200 KeepAwakeView | 400 { error }
import type { KeepAwake } from './hold.ts';

export type KeepAwakeAnswer = { status: number; body: unknown };
type ReadBody = () => Promise<Record<string, unknown>>;

export async function keepAwakeRoute(parts: readonly string[], method: string, readBody: ReadBody, keepAwake: KeepAwake): Promise<KeepAwakeAnswer | null> {
  if (parts[1] !== 'keep-awake' || parts.length !== 2) return null;
  if (method === 'GET') return { status: 200, body: await keepAwake.refresh() };
  if (method !== 'PUT') return null;
  const { enabled } = await readBody();
  if (typeof enabled !== 'boolean') return { status: 400, body: { error: 'enabled must be true or false.' } };
  return { status: 200, body: await keepAwake.set(enabled) };
}
