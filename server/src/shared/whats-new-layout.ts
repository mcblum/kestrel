// How a release's notes are laid out on the What's new page, read from the Markdown itself (Matt,
// 2026-11-25; docs/designs/kestrel.md, "What's new", and whats-new-handoff.md). A small opt-in
// convention, read from parsed Markdown blocks so a heading-like line in a code fence or a list never
// starts a section:
//
//   # Kestrel 0.0.32                       the title (whats-new.ts parseNotes; not part of the body here)
//   ## Kestrel Connect                     the spotlight: its feature name, optional
//   ### See your sessions from any computer.   its headline
//   A sentence or two.                     its description
//   [Open Connections](#/settings/connections)   its one action, a link on a line of its own
//   ![End-to-end encrypted](images/connect-devices.svg)   its picture, optional; the alt text is its caption
//   ## Also in this release                entries, each a ### headline, a sentence or two, a link
//   ## More changes                        the same, folded on the page; optional
//
// The structure is recognised only when the top-level headings are exactly that sequence; anything else
// is `plain`, and the page draws it as ordinary Markdown. A file that looks as if it meant the sequence
// and misses it fails the shape check, naming what is missing, rather than quietly drawing as plain. Each part keeps its own Markdown source, so the
// page draws it through the app's one Markdown component. Pure: the server's tests and the page use it.
import type { Heading, Image, Link, Paragraph, PhrasingContent, RootContent } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';

export const ALSO_HEADING = 'Also in this release';
export const MORE_HEADING = 'More changes';

/** A link on a line of its own: what a part offers to do next. */
export interface NotesAction {
  label: string;
  href: string;
}

/** A picture on a line of its own. An `.svg` is a drawing the page puts inline (whats-new-svg.ts); `alt` is its caption. */
export interface NotesPictureRef {
  src: string;
  alt: string;
}

export interface NotesEntry {
  /** The ### headline. */
  title: string;
  /** The Markdown under it, its action and picture left out. */
  body: string;
  action: NotesAction | null;
  picture: NotesPictureRef | null;
}

export interface Spotlight extends NotesEntry {
  /** The ## feature name, drawn as the spotlight's label. */
  label: string;
}

export type NotesLayout = { kind: 'plain' } | { kind: 'structured'; spotlight: Spotlight | null; also: NotesEntry[]; more: NotesEntry[] };

const PLAIN: NotesLayout = { kind: 'plain' };

const textOf = (nodes: readonly (RootContent | PhrasingContent)[]): string =>
  nodes.map((n) => ('value' in n && typeof n.value === 'string' && n.type !== 'html' ? n.value : 'children' in n ? textOf(n.children as RootContent[]) : '')).join('');

const only = (p: Paragraph) => (p.children.length === 1 ? p.children[0]! : null);
const actionOf = (n: RootContent): NotesAction | null => {
  const child = n.type === 'paragraph' ? only(n) : null;
  return child?.type === 'link' ? { label: textOf((child as Link).children), href: (child as Link).url } : null;
};
const pictureOf = (n: RootContent): NotesPictureRef | null => {
  const child = n.type === 'paragraph' ? only(n) : null;
  return child?.type === 'image' ? { src: (child as Image).url, alt: (child as Image).alt ?? '' } : null;
};

/** The source of a run of blocks, as written. */
const sliceOf = (source: string, nodes: readonly RootContent[]): string =>
  nodes.length === 0 ? '' : source.slice(nodes[0]!.position!.start.offset!, nodes.at(-1)!.position!.end.offset!).trim();

/** One entry from its blocks (after its ### headline): the first standalone link is its action, the first standalone picture its picture. */
function entryOf(source: string, title: string, blocks: readonly RootContent[]): NotesEntry {
  let action: NotesAction | null = null;
  let picture: NotesPictureRef | null = null;
  const rest = blocks.filter((n) => {
    const a = action ? null : actionOf(n);
    if (a) return void (action = a), false;
    const p = picture ? null : pictureOf(n);
    if (p) return void (picture = p), false;
    return true;
  });
  return { title, body: sliceOf(source, rest), action, picture };
}

const isHeading = (n: RootContent, depth: number): n is Heading => n.type === 'heading' && n.depth === depth;

/** A section's blocks split into ### entries; null when anything comes before its first ###. */
function entriesOf(source: string, blocks: readonly RootContent[]): NotesEntry[] | null {
  if (blocks.length > 0 && !isHeading(blocks[0]!, 3)) return null;
  const entries: NotesEntry[] = [];
  let title = '';
  let run: RootContent[] = [];
  const flush = () => title && entries.push(entryOf(source, title, run));
  for (const n of blocks) {
    if (isHeading(n, 3)) {
      flush();
      title = textOf(n.children);
      run = [];
    } else run.push(n);
  }
  flush();
  return entries;
}

type Section = { name: string; blocks: RootContent[] };

/** The top-level ## sections of a body: null when anything but blank space comes before the first. */
function sectionsOf(body: string): Section[] | null {
  const sections: Section[] = [];
  for (const n of fromMarkdown(body).children) {
    if (isHeading(n, 2)) sections.push({ name: textOf(n.children).trim(), blocks: [] });
    else if (sections.length === 0) return null;
    else sections.at(-1)!.blocks.push(n);
  }
  return sections;
}

type Read = { layout: Extract<NotesLayout, { kind: 'structured' }> } | { missing: string };

/** The structured layout of a body, or what keeps it from being one, in words an author can act on. */
function readLayout(body: string): Read {
  const sections = sectionsOf(body);
  if (!sections) return { missing: 'there is text before the first "## " section' };
  const names = sections.map((s) => s.name);
  const at = names.indexOf(ALSO_HEADING);
  if (at < 0) return { missing: `there is no “## ${ALSO_HEADING}” section` };
  if (at > 1) return { missing: `“## ${ALSO_HEADING}” must come first, or right after the one spotlight section; before it are ${names.slice(0, at).map((n) => `“${n}”`).join(', ')}` };
  const after = names.slice(at + 1);
  if (after.length > 1 || (after.length === 1 && after[0] !== MORE_HEADING)) return { missing: `after “## ${ALSO_HEADING}” only “## ${MORE_HEADING}” may follow, not ${after.filter((n) => n !== MORE_HEADING).map((n) => `“${n}”`).join(', ') || 'a second one'}` };
  if (at === 1 && names[0] === MORE_HEADING) return { missing: `“## ${MORE_HEADING}” comes after “## ${ALSO_HEADING}”, not before it` };
  let spotlight: Spotlight | null = null;
  if (at === 1) {
    const { name, blocks } = sections[0]!;
    const [head, ...rest] = blocks;
    if (!head || !isHeading(head, 3)) return { missing: `the spotlight “${name}” must start with a “### ” headline` };
    if (rest.some((n) => n.type === 'heading')) return { missing: `the spotlight “${name}” has more than its one headline` };
    spotlight = { label: name, ...entryOf(body, textOf(head.children), rest) };
  }
  const also = entriesOf(body, sections[at]!.blocks);
  if (!also) return { missing: `“## ${ALSO_HEADING}” has text before its first “### ” entry` };
  const more = sections[at + 1] ? entriesOf(body, sections[at + 1]!.blocks) : [];
  if (!more) return { missing: `“## ${MORE_HEADING}” has text before its first “### ” entry` };
  return { layout: { kind: 'structured', spotlight, also, more } };
}

/** The layout of a notes body (the Markdown under the title). */
export function notesLayout(body: string): NotesLayout {
  const read = readLayout(body);
  return 'layout' in read ? read.layout : PLAIN;
}

/**
 * Whether a body looks as if it meant to use the layout: a section named Also in this release or More
 * changes, or a first section that opens with a "### " headline. Such a file that misses the full
 * sequence is an author's slip, not a plain release, and the shape check says what is missing.
 */
function meantStructured(sections: readonly Section[] | null): boolean {
  if (!sections) return false;
  if (sections.some((s) => s.name === ALSO_HEADING || s.name === MORE_HEADING)) return true;
  const first = sections[0]?.blocks[0];
  return first !== undefined && isHeading(first, 3);
}

// ---- keeping entries short -------------------------------------------------------------------
// Each entry is a headline, a sentence or two, and at most one link (Matt, 2026-11-25: "A headline for
// the feature, a brief description, and then a link to where to enable / configure / use it").

/** The most an entry's text may be, in characters, not counting its link line or a picture. */
export const NOTES_ENTRY_MAX = 200;

const links = (nodes: readonly RootContent[]): number =>
  nodes.reduce((sum, n) => sum + (n.type === 'link' ? 1 : 0) + ('children' in n ? links(n.children as RootContent[]) : 0), 0);

/** What makes one entry too long or too busy, naming it. */
function entryProblems(where: string, entry: NotesEntry): string[] {
  const blocks = fromMarkdown(entry.body).children;
  const problems: string[] = [];
  if (blocks.some((n) => n.type === 'list')) problems.push(`${where} has a list: write a sentence or two instead`);
  if (blocks.some((n) => n.type === 'heading')) problems.push(`${where} has a heading inside it: an entry is a headline, a sentence or two and a link`);
  const count = links(blocks) + (entry.action ? 1 : 0);
  if (count > 1) problems.push(`${where} has ${count} links: at most one, to where the feature is set up or used`);
  const text = textOf(blocks).replace(/\s+/g, ' ').trim();
  if (text === '') problems.push(`${where} has no description`);
  if (text.length > NOTES_ENTRY_MAX) problems.push(`${where} is ${text.length} characters: at most ${NOTES_ENTRY_MAX}, not counting its link`);
  return problems;
}

/**
 * What breaks the short shape in a notes body, one line each, naming the entry. A structured file is
 * checked per entry (the spotlight, then each ### under Also in this release and More changes); any
 * other file per ## section, each read as one entry. Empty when it keeps the shape.
 */
export function notesFormatProblems(body: string): string[] {
  const read = readLayout(body);
  if ('layout' in read) {
    const { spotlight, also, more } = read.layout;
    return [
      ...(spotlight ? entryProblems(`The spotlight “${spotlight.label}”`, spotlight) : []),
      ...also.flatMap((e) => entryProblems(`“${e.title}” (${ALSO_HEADING})`, e)),
      ...more.flatMap((e) => entryProblems(`“${e.title}” (${MORE_HEADING})`, e)),
    ];
  }
  const sections = sectionsOf(body);
  if (meantStructured(sections)) return [`the notes look laid out as a spotlight, “${ALSO_HEADING}” and “${MORE_HEADING}”, but ${read.missing}`];
  if (!sections) return ['there is text before the first section: every part of the notes is a "## " section'];
  return sections.flatMap(({ name, blocks }) => entryProblems(`“${name}”`, entryOf(body, name, blocks)));
}
