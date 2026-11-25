// The rules a tag suggestion passes before anyone sees it. Pure, so each rule is pinned by tests.
//
// 1. Grounding: the model cannot invent tags. A tag is accepted only when it is already a tag in the
//    workspace (or an existing tag plus extra words, which becomes that tag: shared/tag-match.ts), or its text literally appears (any case) in what the user wrote in this session, its
//    title or its branch name (`texts`; linked pull requests are not read yet).
// 2. Not annoying: never for a tag the session (or the session it came from) already has; never
//    again for a tag already suggested in this session; one open tag suggestion at a time; at most
//    MAX_TAG_SUGGESTIONS asked per session.
// 3. Policy: the user's rule for this kind of tag (shared/tag-rules.ts) says ask, apply, or stay quiet.
import { closestExistingTag } from '../shared/tag-match.ts';
import { hasTag, parseTag, sameTag, tagKey } from '../shared/tags.ts';
import { cleanSource, isTagCategory, kindLabel, ruleFor, type TagCategory, type TagSuggestionPrefs } from '../shared/tag-rules.ts';
import type { Suggestion } from '../shared/suggestions.ts';

/** Tag suggestions a session may show as cards, in all. "Always" ones applied by a rule do not count. */
export const MAX_TAG_SUGGESTIONS = 3;
const REASON_MAX = 200;

export interface TagProposal {
  tag: string;
  category: TagCategory;
  source: string | null;
  reason: string;
}

/** The model's payload, validated; or why it is not one. */
export function parseTagProposal(raw: Record<string, unknown>): TagProposal | { reason: string } {
  const parsed = parseTag(raw.tag);
  if ('reason' in parsed) return { reason: `tag: ${parsed.reason}` };
  if (!isTagCategory(raw.category)) return { reason: 'category must be ticket, release or feature.' };
  const reason = typeof raw.reason === 'string' ? raw.reason.trim().replace(/\s+/g, ' ').slice(0, REASON_MAX) : '';
  return { tag: parsed.tag, category: raw.category, source: cleanSource(raw.source), reason };
}

export interface Grounds {
  /** Every tag in use in the workspace, the most used first. */
  existingTags: readonly string[];
  /** Where a new tag's text may appear: the user's messages, the title, the branch. */
  texts: readonly string[];
}

/**
 * The tag to suggest, or why it is refused. An existing tag that covers it comes first, in its own
 * writing: the same tag, or the tag it adds words to ("Argus CLI" is Argus; shared/tag-match.ts).
 */
export function groundTag(tag: string, grounds: Grounds): { tag: string } | { refused: string } {
  const existing = closestExistingTag(tag, grounds.existingTags);
  if (existing) return { tag: existing };
  const needle = tagKey(tag);
  if (grounds.texts.some((text) => text.toLowerCase().includes(needle))) return { tag };
  return { refused: `"${tag}" is not a tag in this workspace and does not appear in what the user wrote or the session's title or branch. Suggest only a tag that is named there.` };
}

export interface TagSituation {
  prefs: TagSuggestionPrefs;
  /** The session's own tags (inherited ones included). */
  sessionTags: readonly string[];
  /** Tags of the session it was handed off, delegated or spawned from. */
  parentTags: readonly string[];
  /** The tag suggestions already in this session's conversation, oldest first. */
  earlier: readonly Suggestion[];
}

export type TagVerdict = { type: 'refuse'; reason: string } | { type: 'skip'; text: string } | { type: 'ask' } | { type: 'auto' };

const proposedTag = (s: Suggestion): string => (typeof s.payload.tag === 'string' ? s.payload.tag : '');

/** Whether to ask, apply at once, or stay quiet, and what to tell the model when nothing is shown. */
export function tagVerdict(p: TagProposal, at: TagSituation): TagVerdict {
  if (!at.prefs.enabled) return { type: 'refuse', reason: 'The user has turned tag suggestions off. Do not suggest tags.' };
  if (hasTag(at.sessionTags, p.tag)) return { type: 'skip', text: `Not shown: this session is already tagged ${p.tag}.` };
  if (hasTag(at.parentTags, p.tag)) return { type: 'skip', text: `Not shown: the session this one came from is already tagged ${p.tag}.` };
  if (at.earlier.some((s) => sameTag(proposedTag(s), p.tag))) return { type: 'skip', text: `Not shown: ${p.tag} was already suggested in this session. Do not suggest it again.` };
  if (at.earlier.some((s) => s.state === 'open')) return { type: 'skip', text: 'Not shown: another tag suggestion is still waiting for the user.' };
  const rule = ruleFor(at.prefs, p.category, p.source);
  if (rule === 'never') return { type: 'skip', text: `Not shown: the user turned off suggestions for ${kindLabel(p.category, p.source).toLowerCase()}. Do not suggest these again.` };
  if (rule === 'always') return { type: 'auto' };
  if (at.earlier.filter((s) => !s.auto).length >= MAX_TAG_SUGGESTIONS) return { type: 'skip', text: `Not shown: this session has had ${MAX_TAG_SUGGESTIONS} tag suggestions already. Do not suggest more.` };
  return { type: 'ask' };
}
