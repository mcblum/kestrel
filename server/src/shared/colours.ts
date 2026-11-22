// Settings → Colours (Matt, 2026-11-22): the few colours in Kestrel's chrome that say what kind of
// thing a row is, never its state. A short, muted palette, as Notion's is, so every choice looks
// right in light and dark. Green, yellow and red are left out on purpose: they are the status dots
// and errors, and a title in one would read as a state. The colours themselves are defined once, as
// CSS custom properties (`--palette-<name>` in ui/src/styles/colours.css); this file holds the names.
// Pure, shared with the UI.
import { tagKey } from './tags.ts';

export const PALETTE = ['grey', 'brown', 'orange', 'teal', 'blue', 'indigo', 'purple', 'pink'] as const;
export type PaletteColour = (typeof PALETTE)[number];

export const PALETTE_LABEL: Record<PaletteColour, string> = {
  grey: 'Grey',
  brown: 'Brown',
  orange: 'Orange',
  teal: 'Teal',
  blue: 'Blue',
  indigo: 'Indigo',
  purple: 'Purple',
  pink: 'Pink',
};

export const isPaletteColour = (value: unknown): value is PaletteColour => typeof value === 'string' && (PALETTE as readonly string[]).includes(value);

export interface ColourSettings {
  /** A colour per tag, by `tagKey`. A tag with none is not listed. */
  tags: Readonly<Record<string, PaletteColour>>;
  /** A colour per project, by its id. A project with none is not listed. */
  projects: Readonly<Record<string, PaletteColour>>;
  /** A colour per workstream, by its id (Matt, 2026-11-22: one colour for every workstream said nothing). */
  workstreams: Readonly<Record<string, PaletteColour>>;
  /** Whether workstreams are coloured at all, and a new one given a colour (Matt, 2026-11-22). On by default. */
  workstreamColours: boolean;
}

/** The longest project or workstream id stored; an id is Kestrel's own, so anything longer is not one. */
export const ID_MAX = 200;

export const DEFAULT_COLOURS: ColourSettings = { tags: {}, projects: {}, workstreams: {}, workstreamColours: true };

/** A map of ids to palette colours, keeping only what is one. */
function byId(raw: unknown): Record<string, PaletteColour> {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(Object.entries(value).filter(([id, colour]) => id && id.length <= ID_MAX && isPaletteColour(colour))) as Record<string, PaletteColour>;
}

/** Settings as stored or sent, made whole: anything unknown or malformed falls back to the default. */
export function sanitizeColours(raw: unknown): ColourSettings {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const tagsIn = typeof value.tags === 'object' && value.tags !== null ? (value.tags as Record<string, unknown>) : {};
  const tags = Object.fromEntries(Object.entries(tagsIn).flatMap(([tag, colour]) => (isPaletteColour(colour) && tagKey(tag) ? [[tagKey(tag), colour]] : [])));
  return { tags, projects: byId(value.projects), workstreams: byId(value.workstreams), workstreamColours: value.workstreamColours !== false };
}

/** A tag's colour, or null when it has none. */
export const tagColour = (colours: ColourSettings, tag: string): PaletteColour | null => colours.tags[tagKey(tag)] ?? null;

/** A workstream's colour, or null when it has none or workstreams are not coloured. */
export const workstreamColour = (colours: ColourSettings, workstreamId: string): PaletteColour | null => (colours.workstreamColours ? colours.workstreams[workstreamId] ?? null : null);

/**
 * The colour a new workstream is given (Matt, 2026-11-22): the one the fewest of the workstreams still
 * listed use, never Grey (it reads as no colour); a tie goes to the first in the palette, so the
 * choice is stable and neighbours differ. Only at creation: a colour the user changes or clears stays so.
 */
export function nextWorkstreamColour(colours: ColourSettings, liveIds: readonly string[]): PaletteColour {
  const choices = PALETTE.filter((c) => c !== 'grey');
  const used = new Map<PaletteColour, number>(choices.map((c) => [c, 0]));
  for (const id of liveIds) {
    const colour = colours.workstreams[id];
    if (colour && used.has(colour)) used.set(colour, used.get(colour)! + 1);
  }
  return choices.reduce((best, c) => (used.get(c)! < used.get(best)! ? c : best), choices[0]!);
}

/** A project's colour, or null when it has none. */
export const projectColour = (colours: ColourSettings, projectId: string | null): PaletteColour | null => (projectId ? colours.projects[projectId] ?? null : null);

/** What `sessionColour` reads of a session: the project it is filed under. */
export interface ColouredSession {
  filing: { projectId: string | null };
}

/**
 * The colour a session's row is marked with: its project's (Matt, 2026-11-22). Colour says where a
 * row belongs, so it has one source; a tag's colour stays on the tag and its chip, and a session
 * whose project has none falls back to the review colour where it is a review, as before.
 */
export const sessionColour = (colours: ColourSettings, session: ColouredSession): PaletteColour | null => projectColour(colours, session.filing.projectId);
