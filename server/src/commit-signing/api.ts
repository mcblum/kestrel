// HTTP route for Settings → Workflow → "Commit signing". Shaped like project-edits/api.ts. Behind
// the same token, Origin and Host checks as every route; no Kestrel tool reaches it.
//
//   GET   /api/commit-signing                      200 { allowed }
//   PATCH /api/commit-signing  { allowed: boolean } 200 { allowed } | 400 { error }
import type { CommitSigning } from './prefs.ts';

export type CommitSigningAnswer = { status: number; body: unknown };
type ReadBody = () => Promise<Record<string, unknown>>;

export async function commitSigningRoute(parts: readonly string[], method: string, readBody: ReadBody, signing: CommitSigning): Promise<CommitSigningAnswer | null> {
  if (parts[1] !== 'commit-signing' || parts.length !== 2) return null;
  if (method === 'GET') return { status: 200, body: await signing.prefs() };
  if (method !== 'PATCH') return null;
  const body = await readBody();
  if (typeof body.allowed !== 'boolean') return { status: 400, body: { error: 'allowed must be true or false.' } };
  return { status: 200, body: await signing.setAllowed(body.allowed) };
}
