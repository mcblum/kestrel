// HTTP route for Settings → Workflow → "Commands kept per session". Shaped like limits-api.ts. The
// UI's only; no Kestrel tool reaches it.
//
//   GET /api/commands-kept                 200 { kept, defaultKept }
//   PUT /api/commands-kept  { kept }       200 { kept, defaultKept } | 400 { error }
import { Refused } from '../refused.ts';
import type { CommandsKept } from './prefs.ts';

export type CommandsKeptAnswer = { status: number; body: unknown };
type ReadBody = () => Promise<Record<string, unknown>>;

export async function commandsKeptRoute(parts: readonly string[], method: string, readBody: ReadBody, prefs: CommandsKept): Promise<CommandsKeptAnswer | null> {
  if (parts[1] !== 'commands-kept' || parts.length !== 2) return null;
  if (method === 'GET') return { status: 200, body: await prefs.view() };
  if (method !== 'PUT') return null;
  try {
    return { status: 200, body: await prefs.set((await readBody()).kept) };
  } catch (error) {
    if (error instanceof Refused) return { status: 400, body: { error: error.message } };
    throw error;
  }
}
