// HTTP route for Settings → Colours (shared/colours.ts). The UI's only; no Kestrel tool reaches it.
//
//   GET /api/colours                                             200 ColourSettings
//   PUT /api/colours  { tag: string, colour: PaletteColour | null } 200 ColourSettings | 400 { error }
//   PUT /api/colours  { project: id, colour: PaletteColour | null } 200 ColourSettings | 400 { error }
//   PUT /api/colours  { workstream: id, colour: PaletteColour | null } 200 ColourSettings | 400 { error }
//   PUT /api/colours  { workstreamColours: boolean }                  200 ColourSettings | 400 { error }
//
// A colour is a palette name, or null to take it off.
import { ID_MAX, isPaletteColour, PALETTE, type ColourSettings } from '../shared/colours.ts';
import { parseTag, tagKey } from '../shared/tags.ts';
import type { ColourPrefs } from './prefs.ts';

export type ColoursAnswer = { status: number; body: unknown };
type ReadBody = () => Promise<Record<string, unknown>>;

const bad = (error: string): ColoursAnswer => ({ status: 400, body: { error } });
const CHOICES = `${PALETTE.join(', ')}`;

function withTag(current: ColourSettings, tag: string, colour: unknown): ColourSettings {
  const { [tagKey(tag)]: _old, ...rest } = current.tags;
  return { ...current, tags: isPaletteColour(colour) ? { ...rest, [tagKey(tag)]: colour } : rest };
}

/** `current` with one project's or workstream's colour set, or taken off for null. */
function withId(current: ColourSettings, kind: 'projects' | 'workstreams', id: string, colour: unknown): ColourSettings {
  const { [id]: _old, ...rest } = current[kind];
  return { ...current, [kind]: isPaletteColour(colour) ? { ...rest, [id]: colour } : rest };
}

export async function coloursRoute(parts: readonly string[], method: string, readBody: ReadBody, prefs: ColourPrefs): Promise<ColoursAnswer | null> {
  if (parts[1] !== 'colours' || parts.length !== 2) return null;
  if (method === 'GET') return { status: 200, body: await prefs.current() };
  if (method !== 'PUT') return null;
  const body = await readBody();
  if (body.tag !== undefined) {
    const parsed = parseTag(body.tag);
    if ('reason' in parsed) return bad(parsed.reason);
    if (body.colour !== null && !isPaletteColour(body.colour)) return bad(`A tag's colour must be one of: ${CHOICES}, or null for none.`);
    return { status: 200, body: await prefs.update((current) => withTag(current, parsed.tag, body.colour)) };
  }
  for (const [field, kind] of [['project', 'projects'], ['workstream', 'workstreams']] as const) {
    if (body[field] === undefined) continue;
    const id = body[field];
    if (typeof id !== 'string' || !id || id.length > ID_MAX) return bad(`${field} must be a ${field}'s id.`);
    if (body.colour !== null && !isPaletteColour(body.colour)) return bad(`A ${field}'s colour must be one of: ${CHOICES}, or null for none.`);
    return { status: 200, body: await prefs.update((current) => withId(current, kind, id, body.colour)) };
  }
  if (body.workstreamColours !== undefined) {
    if (typeof body.workstreamColours !== 'boolean') return bad('workstreamColours must be true or false.');
    const on = body.workstreamColours;
    return { status: 200, body: await prefs.update((current) => ({ ...current, workstreamColours: on })) };
  }
  return bad('Send a tag, project or workstream and its colour, or workstreamColours.');
}
