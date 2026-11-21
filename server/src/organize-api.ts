// HTTP routes for organizing: tags on sessions, and pins. Shaped like sim-api.ts: the caller hands
// over the path parts and a body reader, and gets an answer, or null when the path is not one of these.
//
//   POST   /api/sessions/:id/tags        { tag }               adds a tag; 200 { tags }
//   DELETE /api/sessions/:id/tags/:tag                         takes it off (any case); 200 { tags }
//   POST   /api/pins                     { kind, id, pinned }  pins (or with pinned: false unpins); 204
//   POST   /api/pins/order               { pins: [{kind,id}] } reorders; must list every pin in sight once; 204
import { isPinKind, MAX_PIN_ID_LENGTH, parsePinOrder } from './shared/pins.ts';
import { parseTag } from './shared/tags.ts';
import type { Workspace } from './workspace.ts';

export type OrganizeAnswer = { status: number; body?: unknown };
type ReadBody = () => Promise<Record<string, unknown>>;

const segment = (raw: string): string | null => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
};

/** Answers a tag or pin route, or null when the path is not one. Bad input is a 400; no such item is thrown as `Refused`. */
export async function organizeRoute(parts: readonly string[], method: string, readBody: ReadBody, workspace: Workspace): Promise<OrganizeAnswer | null> {
  if (parts[1] === 'pins' && parts.length === 2 && method === 'POST') return pinRoute(await readBody(), workspace);
  if (parts[1] === 'pins' && parts[2] === 'order' && parts.length === 3 && method === 'POST') return pinOrderRoute(await readBody(), workspace);
  if (parts[1] !== 'sessions' || parts[3] !== 'tags') return null;
  const id = parts[2]!;
  if (method === 'POST' && parts.length === 4) {
    const parsed = parseTag((await readBody()).tag);
    if ('reason' in parsed) return { status: 400, body: { error: parsed.reason } };
    return { status: 200, body: { tags: await workspace.tagSession(id, parsed.tag) } };
  }
  if (method === 'DELETE' && parts.length === 5) {
    const tag = segment(parts[4]!);
    if (tag === null) return { status: 400, body: { error: 'The tag in the path is not valid.' } };
    return { status: 200, body: { tags: await workspace.untagSession(id, tag) } };
  }
  return null;
}

async function pinRoute(body: Record<string, unknown>, workspace: Workspace): Promise<OrganizeAnswer> {
  if (!isPinKind(body.kind)) return { status: 400, body: { error: 'kind must be session, project, group or review' } };
  if (typeof body.id !== 'string' || !body.id || body.id.length > MAX_PIN_ID_LENGTH) return { status: 400, body: { error: 'id is required' } };
  await workspace.setPinned(body.kind, body.id, body.pinned !== false);
  return { status: 204 };
}

async function pinOrderRoute(body: Record<string, unknown>, workspace: Workspace): Promise<OrganizeAnswer> {
  const order = parsePinOrder(body.pins);
  if ('reason' in order) return { status: 400, body: { error: order.reason } };
  await workspace.setPinOrder(order);
  return { status: 204 };
}
