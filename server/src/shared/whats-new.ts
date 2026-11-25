// What's new: the rules, pure, for the server, the page and the release scripts alike
// (docs/designs/kestrel.md, "What's new"). The notes are one Markdown file per release in the
// repository's `whats-new/` folder (`whats-new/0.0.32.md`): a title line, then a few sections for a
// person who uses the app. They ship inside the app, the server serves them by route, and the same
// file is the release's notes on the host (scripts/release/release-notes.mjs).
//
// A beta shows the notes of the release it is a beta of (0.0.32-beta.7 shows 0.0.32.md); those grow
// through the cycle. They open by themselves once per distinct file: what was last shown is kept as
// the release and a hash of the file (`WhatsNewShown`), so a beta whose notes did not change opens
// nothing and one whose notes grew opens them again.

/** A release, `1.2.3`. */
const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;
/** A version as app/release-channel.mjs knows them: `1.2.3` or `1.2.3-beta.4`. */
const VERSION = /^(\d+\.\d+\.\d+)(?:-beta\.\d+)?$/;

export const isRelease = (value: unknown): value is string => typeof value === 'string' && RELEASE.test(value);

/** The release a version's notes are for: `0.0.32-beta.7` → `0.0.32`. Null for anything else. */
export function releaseOf(version: string): string | null {
  return VERSION.exec(version.trim())?.[1] ?? null;
}

/** The notes file of a release, as it is named in `whats-new/`. */
export const notesFileName = (release: string): string => `${release}.md`;

/** The release a notes file is for, from its name; null for any other file. */
export function releaseOfFile(name: string): string | null {
  const m = /^(\d+\.\d+\.\d+)\.md$/.exec(name);
  return m ? m[1]! : null;
}

/** Newest first. */
export function compareReleases(a: string, b: string): number {
  const pa = RELEASE.exec(a)!.slice(1).map(Number);
  const pb = RELEASE.exec(b)!.slice(1).map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i]! - pa[i]!;
  return 0;
}

export interface ParsedNotes {
  /** The first line, `# …`, without the mark. */
  title: string;
  /** Everything after the title line, trimmed. */
  body: string;
}

/**
 * A notes file read: its title (the first non-empty line, a level-one heading) and the rest. Null with
 * a reason when it is not one: the release script fails on that reason, the server leaves the file out.
 */
export function parseNotes(text: string): ParsedNotes | { error: string } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0) return { error: 'it is empty' };
  const heading = /^#\s+(.+?)\s*#*\s*$/.exec(lines[first]!);
  if (!heading) return { error: 'its first line must be the title, a heading starting with "# "' };
  const body = lines.slice(first + 1).join('\n').trim();
  if (body === '') return { error: 'it has a title and nothing under it' };
  return { title: heading[1]!, body };
}

// A note may link to a place in the app: an ordinary Markdown link whose target is one of the app's
// page addresses (`[Open Settings → Git](#/settings/git)`). The What's new page follows it in the app;
// the host's copy has no app to go to, so `withoutAppLinks` takes them out.
const APP_LINK = /\[([^\]]*)\]\((#\/[^)\s]*)\)/g;
/** A line that is only such a link, perhaps as a list item and with a full stop. */
const LINK_LINE = /^\s*(?:[-*+]\s+)?\[[^\]]*\]\(#\/[^)\s]*\)[.!?]?\s*$/;
/** A sentence that is only such a link: at the start of a line or after another sentence's end. */
const LINK_SENTENCE = /(^|[.!?]\s+)\[[^\]]*\]\(#\/[^)\s]*\)[.!?]?(?=\s|$)/g;

/** Every in-app link target in a notes file, in order. */
export function appLinksIn(text: string): string[] {
  return [...text.matchAll(APP_LINK)].map((m) => m[2]!);
}

/**
 * The notes without their in-app links: a line or sentence that is only such a link is dropped, and a
 * link inside a sentence becomes its plain text. Nothing else is changed.
 */
export function withoutAppLinks(text: string): string {
  const lines = text.split('\n').flatMap((line) => {
    if (LINK_LINE.test(line)) return [];
    if (!line.includes('](#/')) return [line];
    const plain = line.replace(LINK_SENTENCE, '$1').replace(APP_LINK, '$1');
    // A dropped sentence leaves its neighbours' spaces side by side, or a line's end.
    return [plain.replace(/([.!?]) {2,}/g, '$1 ').replace(/[ \t]+$/, '')];
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** The notes as the release on the host shows them: the body, pictures and in-app links left out (they need the app). */
export function hostNotes(parsed: ParsedNotes): string {
  return withoutAppLinks(
    parsed.body
      .split('\n')
      .filter((line) => !/^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(line))
      .join('\n'),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The notes last opened by themselves (or counted as seen), by release and the hash of the file. */
export type WhatsNewShown = { release: string; hash: string } | null;

/** The record the server keeps: what was shown, and the Settings → General switch. */
export interface WhatsNewRecord {
  shown: WhatsNewShown;
  /** "Show what's new after an update". On by default. */
  enabled: boolean;
}

export const DEFAULT_WHATS_NEW: WhatsNewRecord = { shown: null, enabled: true };

const isHash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{16,128}$/.test(value);

export function sanitizeShown(value: unknown): WhatsNewShown {
  if (typeof value !== 'object' || value === null) return null;
  const { release, hash } = value as Record<string, unknown>;
  return isRelease(release) && isHash(hash) ? { release, hash } : null;
}

/** A stored record, well-formed or the default. Null when nothing was stored at all: that is how a first run is told apart. */
export function sanitizeRecord(value: unknown): WhatsNewRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  return { shown: sanitizeShown(v.shown), enabled: v.enabled !== false };
}

/** The notes this copy carries for its own release: the file's release and hash. */
export type CurrentNotes = { release: string; hash: string } | null;

/**
 * Whether the notes open by themselves on this start. Only the installed app; never with the switch
 * off; never when this copy has no notes for its release; never twice for the same file. A first run
 * (no record and nothing used before) is not an update: see `firstRecord`.
 */
export function isDue(input: { packaged: boolean; record: WhatsNewRecord; notes: CurrentNotes }): boolean {
  const { packaged, record, notes } = input;
  if (!packaged || !record.enabled || !notes) return false;
  return !(record.shown?.release === notes.release && record.shown.hash === notes.hash);
}

/**
 * The record when none was stored. A copy that was used before (an earlier version kept the window's
 * tabs) was updated: its notes are due. A first install was not: what it carries counts as shown.
 */
export function firstRecord(input: { usedBefore: boolean; notes: CurrentNotes }): WhatsNewRecord {
  return input.usedBefore || !input.notes ? DEFAULT_WHATS_NEW : { ...DEFAULT_WHATS_NEW, shown: input.notes };
}

/** One release's notes in the list ("Earlier releases"). */
export interface WhatsNewEntry {
  release: string;
  title: string;
}

/** What every window is pushed. */
export interface WhatsNewView {
  /** The release this copy is (or is a beta of), or null when it cannot be told. */
  release: string | null;
  /** Notes waiting to be opened by themselves: the window opens them once, then says so. */
  due: { release: string; hash: string } | null;
  enabled: boolean;
  /** Every release with notes, newest first. */
  releases: WhatsNewEntry[];
}

/** One release's notes, as the page asks for them by route. */
export interface WhatsNewNotes extends WhatsNewEntry {
  hash: string;
  /** The Markdown under the title. */
  body: string;
}

/** A picture the notes may show: `whats-new/images/<name>`. */
export const NOTES_PICTURE = /^[a-z0-9][a-z0-9._-]{0,80}\.(png|jpe?g|gif|webp)$/i;

/** The page's route: the current release's notes, or one release's (`#/whats-new/0.0.31`). */
export const whatsNewPath = (release?: string): string => (release ? `#/whats-new/${release}` : '#/whats-new');

