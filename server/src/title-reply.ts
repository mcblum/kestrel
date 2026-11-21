// The title call's reply: the title on its first line, then optionally one line per tag the first
// message names (agents/title-request.ts asks for `tag: <name> | <category> | <source>`). Read
// defensively: a reply with only a title is the common case, and a tag line that cannot be read is
// dropped without touching the title. The candidates go through the same grounding and policy as
// the `suggest` tool (suggestions/service.ts `fromTitle`).
import { cleanTitle } from './title.ts';
import { cleanSource, isTagCategory } from './shared/tag-rules.ts';
import { parseTag } from './shared/tags.ts';

/** Tag candidates read from one reply, at most. */
export const MAX_TITLE_TAGS = 3;
/** What the user sees under a tag suggestion that came from the title call. */
export const TITLE_TAG_REASON = 'Named in your first message';

const TAG_LINE = /^[\s\-*_`>]*tags?\s*[*_]*\s*:\s*(.*)$/i;
const WRAPPING = /^[\s"'`*_“”‘’]+|[\s"'`*_“”‘’.]+$/g;
const NO_SOURCE = new Set(['', '-', 'none', 'n/a', 'unknown', 'empty']);

export interface TitleReply {
  title: string | null;
  /** Payloads for a kind "tag" suggestion. */
  tags: Record<string, unknown>[];
}

const unwrap = (part: string | undefined): string => (part ?? '').replace(WRAPPING, '').trim();

/** One `tag: name | category | source` line as a candidate; null when it cannot be read. */
function tagFrom(body: string): Record<string, unknown> | null {
  const [name, rawCategory, rawSource] = body.split('|').map(unwrap);
  const category = (rawCategory ?? '').toLowerCase();
  const parsed = parseTag(name);
  if ('reason' in parsed || !isTagCategory(category)) return null;
  const source = NO_SOURCE.has((rawSource ?? '').toLowerCase()) ? null : cleanSource(rawSource);
  return { tag: parsed.tag, category, ...(source ? { source } : {}), reason: TITLE_TAG_REASON };
}

export function parseTitleReply(raw: string): TitleReply {
  const lines = raw.split('\n');
  const tagBodies = lines.map((l) => TAG_LINE.exec(l.trim())?.[1]).filter((b): b is string => b !== undefined);
  const titleLines = lines.filter((l) => !TAG_LINE.test(l.trim()));
  const tags = tagBodies.map(tagFrom).filter((t): t is Record<string, unknown> => t !== null).slice(0, MAX_TITLE_TAGS);
  return { title: cleanTitle(titleLines.join('\n')), tags };
}
