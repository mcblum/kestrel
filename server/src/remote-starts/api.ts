// HTTP route for Settings → Workflow → "Other devices may start sessions on this computer".
//
//   GET   /api/remote-starts                      200 { allowed }
//   PATCH /api/remote-starts  { allowed: boolean } 200 { allowed } | 400 { error }
import type { RemoteStarts } from './prefs.ts';

type ReadBody = () => Promise<Record<string, unknown>>;

export async function remoteStartsRoute(parts: readonly string[], method: string, readBody: ReadBody, starts: RemoteStarts): Promise<{ status: number; body: unknown } | null> {
  if (parts[1] !== 'remote-starts' || parts.length !== 2) return null;
  if (method === 'GET') return { status: 200, body: await starts.prefs() };
  if (method !== 'PATCH') return null;
  const body = await readBody();
  if (typeof body.allowed !== 'boolean') return { status: 400, body: { error: 'allowed must be true or false.' } };
  return { status: 200, body: await starts.setAllowed(body.allowed) };
}
