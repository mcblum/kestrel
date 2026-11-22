// Settings → Colours, as the UI holds it (shared/colours.ts): one entry in the app store
// (useResource), read by the setting itself and every row that carries a colour. A colour is put on
// the element that shows it, as `--tint` (styles/colours.css).
import type { CSSProperties } from 'react';
import { DEFAULT_COLOURS, sanitizeColours, projectColour, sessionColour, tagColour, workstreamColour, type ColouredSession, type ColourSettings, type PaletteColour } from '@kestrel/server/colours';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { useResource } from './data/resources.ts';
import { act, call, putResource } from './store.ts';

export const COLOURS_PATH = '/api/colours';
const asColours = (raw: unknown): Sourced<ColourSettings> => ready(sanitizeColours(raw));

/** The settings as they are; the default until the server has answered, or when it cannot. */
export function useColours(): ColourSettings {
  const loaded = useResource(COLOURS_PATH, asColours).value;
  return loaded.state === 'ready' ? loaded.value : DEFAULT_COLOURS;
}

async function save(body: Record<string, unknown>): Promise<void> {
  const stored = await act(() => call<ColourSettings>(COLOURS_PATH, { method: 'PUT', body: JSON.stringify(body) }));
  if (stored) putResource(COLOURS_PATH, ready(sanitizeColours(stored)));
}

export const setTagColour = (tag: string, colour: PaletteColour | null): Promise<void> => save({ tag, colour });
export const setProjectColour = (project: string, colour: PaletteColour | null): Promise<void> => save({ project, colour });
export const setWorkstreamColour = (workstream: string, colour: PaletteColour | null): Promise<void> => save({ workstream, colour });
export const setWorkstreamColours = (on: boolean): Promise<void> => save({ workstreamColours: on });

/** The CSS value of a palette colour. */
export const paletteVar = (colour: PaletteColour): string => `var(--palette-${colour})`;

export interface Tint {
  className: string;
  style: CSSProperties | undefined;
}

const NO_TINT: Tint = { className: '', style: undefined };
const tints = new Map<PaletteColour, Tint>();

/** The class and style that give an element a palette colour; one object per colour, so it keeps its identity. */
export function tintFor(colour: PaletteColour | null): Tint {
  if (!colour) return NO_TINT;
  const held = tints.get(colour);
  if (held) return held;
  const tint = { className: ' tinted', style: { '--tint': paletteVar(colour) } as CSSProperties };
  tints.set(colour, tint);
  return tint;
}

/** The colour a session's row is marked with: its project's (`sessionColour`). */
export function useSessionTint(session: ColouredSession | undefined): Tint {
  const colours = useColours();
  return tintFor(session ? sessionColour(colours, session) : null);
}

/** A project's own colour, for its row. */
export function useProjectTint(projectId: string): Tint {
  return tintFor(projectColour(useColours(), projectId));
}

/** A workstream's own colour, for its block under WORKSTREAMS. */
export function useWorkstreamTint(workstreamId: string): Tint {
  return tintFor(workstreamColour(useColours(), workstreamId));
}

/** A tag's own colour, for its row in TAGS and its chip. */
export function useTagTint(tag: string): Tint {
  return tintFor(tagColour(useColours(), tag));
}
