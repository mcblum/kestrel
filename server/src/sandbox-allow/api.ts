// HTTP route for Settings → Workflow → "Always allowed outside the sandbox". Shaped like
// project-edits/api.ts. Behind the same token, Origin and Host checks as every route; it is the
// UI's only, and no Kestrel tool reaches it (the agent-facing MCP route serves tools only).
//
// Every answer is the whole view: `entries` in effect, and `inactive` (stored entries the rules now
// refuse, each with its reason) when there are any.
//
//   GET    /api/sandbox-allow                                              200 { entries, inactive? }
//   POST   /api/sandbox-allow  { kind: 'command', command: string }        200 { entries, inactive? } | 400 { error }
//   POST   /api/sandbox-allow  { kind: 'folder', path: string, access }    200 { entries, inactive? } | 400 { error }
//   DELETE /api/sandbox-allow  { id: string }                              200 { entries, inactive? } | 400 { error }
//   PATCH  /api/sandbox-allow  { inherit: boolean }                        200 { entries, inactive?, inherit } | 400 { error }
//          (issue 74: sessions started by another session may leave their sandbox unasked when their starter could)
import { Refused } from '../refused.ts';
import type { SandboxAllowList } from './store.ts';

export type SandboxAllowAnswer = { status: number; body: unknown };
type ReadBody = () => Promise<Record<string, unknown>>;

const bad = (error: string): SandboxAllowAnswer => ({ status: 400, body: { error } });

async function added(body: Record<string, unknown>, list: SandboxAllowList) {
  if (body.kind === 'command') {
    if (typeof body.command !== 'string') return bad('command must be text, such as "git commit".');
    return list.addCommand(body.command);
  }
  if (body.kind === 'folder') {
    if (typeof body.path !== 'string') return bad('path must be text, such as "~/.gnupg".');
    return list.addFolder(body.path, body.access);
  }
  return bad('kind must be "command" or "folder".');
}

async function answer(method: string, readBody: ReadBody, list: SandboxAllowList): Promise<SandboxAllowAnswer | null> {
  if (method === 'GET') return { status: 200, body: await list.view() };
  if (method === 'POST') {
    const result = await added(await readBody(), list);
    return 'status' in result ? result : { status: 200, body: result };
  }
  if (method === 'PATCH') {
    const body = await readBody();
    if (typeof body.inherit !== 'boolean') return bad('inherit must be true or false.');
    return { status: 200, body: await list.setInherit(body.inherit) };
  }
  if (method !== 'DELETE') return null;
  const body = await readBody();
  if (typeof body.id !== 'string') return bad('id must name an entry.');
  return { status: 200, body: await list.remove(body.id) };
}

export async function sandboxAllowRoute(parts: readonly string[], method: string, readBody: ReadBody, list: SandboxAllowList): Promise<SandboxAllowAnswer | null> {
  if (parts[1] !== 'sandbox-allow' || parts.length !== 2) return null;
  try {
    return await answer(method, readBody, list);
  } catch (error) {
    if (error instanceof Refused) return bad(error.message);
    throw error;
  }
}
