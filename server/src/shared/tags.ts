// Tags on sessions: short free-text labels (a Jira key like PLAT-1234, a theme). Pure, shared with
// the UI. A tag is trimmed with its inner whitespace collapsed to one space, at most TAG_MAX
// characters. Tags compare without regard to case, and keep the case they were first typed in:
// adding "plat-1234" to a session tagged "PLAT-1234" changes nothing.

export const TAG_MAX = 40;

/** A tag cleaned for storing, or why it cannot be one. */
export function parseTag(raw: unknown): { tag: string } | { reason: string } {
  if (typeof raw !== 'string') return { reason: 'A tag must be text.' };
  const tag = raw.trim().replace(/\s+/g, ' ');
  if (!tag) return { reason: 'Write the tag first.' };
  if (tag.length > TAG_MAX) return { reason: `A tag is at most ${TAG_MAX} characters.` };
  return { tag };
}

/** The form two tags are compared in. */
export const tagKey = (tag: string): string => tag.trim().replace(/\s+/g, ' ').toLowerCase();

export const sameTag = (a: string, b: string): boolean => tagKey(a) === tagKey(b);

export const hasTag = (tags: readonly string[], tag: string): boolean => tags.some((t) => sameTag(t, tag));

/** `tags` with `tag` at the end; the same array when the session already has it (in any case). */
export function addTag(tags: readonly string[], tag: string): readonly string[] {
  return hasTag(tags, tag) ? tags : [...tags, tag];
}

/** `tags` without `tag` (in any case); the same array when it is not there. */
export function removeTag(tags: readonly string[], tag: string): readonly string[] {
  return hasTag(tags, tag) ? tags.filter((t) => !sameTag(t, tag)) : tags;
}

export interface TagCount {
  /** As first typed, on the earliest session that has it. */
  tag: string;
  count: number;
}

/** Every tag in use, the most used first (of equals, alphabetical). */
export const mostUsedTags = (sessions: readonly { tags: readonly string[] }[]): string[] => [...tagCounts(sessions)].sort((a, b) => b.count - a.count).map((t) => t.tag);

/** Every tag in use with how many sessions have it, alphabetical. Sessions come oldest first. */
export function tagCounts(sessions: readonly { tags: readonly string[] }[]): TagCount[] {
  const byKey = new Map<string, TagCount>();
  for (const s of sessions) {
    for (const tag of s.tags) {
      const key = tagKey(tag);
      const seen = byKey.get(key);
      byKey.set(key, seen ? { tag: seen.tag, count: seen.count + 1 } : { tag, count: 1 });
    }
  }
  return [...byKey.values()].sort((a, b) => tagKey(a.tag).localeCompare(tagKey(b.tag), undefined, { numeric: true }));
}
