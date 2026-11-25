// Which existing tag a proposed or typed tag really is, and which tags a tag card offers. Pure and
// shared with the UI. The one place these are decided (Matt, 2026-11-25: with a tag "Argus", a
// suggestion asked about "Argus CLI"; existing tags come first).
//
// A tag a MODEL proposes becomes an existing tag when it is that tag written another way (case,
// spacing, punctuation), or that tag plus extra words ("Argus CLI" with "Argus" in use). Extra words
// that carry a digit name something of their own (a ticket's number, a version), so "PLAT-1234" is
// never folded into "PLAT", nor "Argus v2" into "Argus". A tag the USER types is theirs to choose:
// only its case follows an existing tag.
import type { ChatMessage } from '../model.ts';
import { hasTag, parseTag, sameTag, TAG_MAX, tagKey } from './tags.ts';

/** How many existing tags a tag card offers besides the suggested one. */
export const OFFERED_TAGS = 5;
/** How many tags one answer to a tag card may add. */
export const MAX_PICKED_TAGS = 8;

const WORD = /[\p{L}\p{N}]+/gu;
const DIGIT = /\p{N}/u;
const startsWithDigit = (word: string) => DIGIT.test(word.charAt(0));
const endsWithDigit = (word: string) => DIGIT.test(word.charAt(word.length - 1));

/** A tag's words: runs of letters and digits, without case. "Argus-CLI" and "argus cli" are the same two. */
export const tagWords = (tag: string): string[] => tag.toLowerCase().match(WORD) ?? [];

/**
 * The words run together, so spacing and punctuation do not count; a break between two digits is
 * kept, so "v1.2" is not "v12" and "0.0.32" is not "0.03.2".
 */
function squashed(words: readonly string[]): string {
  return words.reduce((all, word, i) => all + (i > 0 && endsWithDigit(words[i - 1]!) && startsWithDigit(word) ? '.' : '') + word, '');
}

/** Where `run` sits in `words` as consecutive words, or -1. */
function runAt(words: readonly string[], run: readonly string[]): number {
  for (let at = 0; at + run.length <= words.length; at += 1) {
    if (run.every((word, i) => words[at + i] === word)) return at;
  }
  return -1;
}

/** `existing` is `proposed` with words left off, and none of the words left off carries a digit. */
function isThatPlusWords(proposed: readonly string[], existing: readonly string[]): boolean {
  if (existing.length === 0 || existing.length >= proposed.length) return false;
  const at = runAt(proposed, existing);
  if (at < 0) return false;
  const extra = [...proposed.slice(0, at), ...proposed.slice(at + existing.length)];
  return !extra.some((word) => DIGIT.test(word));
}

/**
 * The existing tag a model's proposed tag stands for, in that tag's own writing, or null when it is
 * a tag of its own. The same tag first; then one that differs only in case, spacing or punctuation;
 * then the existing tag it adds words to (the longest such, and of equals the first given, so pass
 * the most used first).
 */
export function closestExistingTag(proposed: string, existingTags: readonly string[]): string | null {
  const same = existingTags.find((t) => sameTag(t, proposed));
  if (same) return same;
  const words = tagWords(proposed);
  if (words.length === 0) return null;
  const key = squashed(words);
  const rewritten = existingTags.find((t) => squashed(tagWords(t)) === key);
  if (rewritten) return rewritten;
  return existingTags.reduce<string | null>((best, t) => {
    const candidate = tagWords(t);
    if (!isThatPlusWords(words, candidate)) return best;
    return best !== null && tagWords(best).length >= candidate.length ? best : t;
  }, null);
}

/** A tag the user typed: the existing tag when one has that name in any case, else as typed. */
export const typedTag = (typed: string, existingTags: readonly string[]): string => existingTags.find((t) => sameTag(t, typed)) ?? typed;

/** `tags` without repeats (in any case), the first writing kept. */
export function uniqueTags(tags: readonly string[]): string[] {
  return tags.reduce<string[]>((kept, tag) => (hasTag(kept, tag) ? kept : [...kept, tag]), []);
}

/**
 * What the user chose on a tag card, as the tags to add: each cleaned, written as the existing tag
 * of that name, without repeats; or why it cannot be taken.
 */
export function pickedTags(picks: readonly unknown[], existingTags: readonly string[]): { tags: string[] } | { reason: string } {
  const cleaned: string[] = [];
  for (const pick of picks) {
    const parsed = parseTag(pick);
    if ('reason' in parsed) return { reason: parsed.reason };
    cleaned.push(typedTag(parsed.tag, existingTags));
  }
  const tags = uniqueTags(cleaned);
  if (tags.length === 0) return { reason: 'Choose at least one tag.' };
  if (tags.length > MAX_PICKED_TAGS) return { reason: `At most ${MAX_PICKED_TAGS} tags at a time.` };
  return { tags };
}

/**
 * `chosen` with what was typed into a tag card's field added: split at commas, each name cleaned and
 * cut to a tag's length, written as the existing tag of that name, never twice, never past
 * MAX_PICKED_TAGS. The same array when nothing was added.
 */
export function withTyped(chosen: readonly string[], typed: string, existingTags: readonly string[]): readonly string[] {
  const names = typed.split(',').flatMap((part) => {
    const parsed = parseTag(part.trim().slice(0, TAG_MAX));
    return 'tag' in parsed ? [typedTag(parsed.tag, existingTags)] : [];
  });
  const next = uniqueTags([...chosen, ...names]).slice(0, MAX_PICKED_TAGS);
  return next.length === chosen.length ? chosen : next;
}

/**
 * `chosen` after a click on one of a tag card's offered chips (Matt, 2026-11-25). A chosen tag is
 * taken off; another is added. While the choice is still `untouched` (the suggested tag, as the card
 * came), the first other tag clicked takes the suggestion's place instead of joining it, so choosing
 * an existing tag over the suggested one is one click. Never past MAX_PICKED_TAGS.
 */
export function withClicked(chosen: readonly string[], tag: string, untouched: boolean): readonly string[] {
  if (hasTag(chosen, tag)) return chosen.filter((t) => !sameTag(t, tag));
  if (untouched) return [tag];
  return chosen.length >= MAX_PICKED_TAGS ? chosen : [...chosen, tag];
}

/** Whether `text` names `tag`: its words in a row, as whole words. */
function names(textWords: readonly string[], tag: string): boolean {
  const words = tagWords(tag);
  return words.length > 0 && runAt(textWords, words) >= 0;
}

export interface OfferFrom {
  /** The tag the card suggests; never offered a second time. */
  suggested: string;
  /** The session's own tags: not offered. */
  sessionTags: readonly string[];
  /** Every session of the workspace. */
  sessions: readonly { tags: readonly string[]; updatedAt: number }[];
  /** What the session is about: the user's messages, its title, its branch. */
  texts: readonly string[];
}

/**
 * The existing tags a tag card offers besides the suggested one, at most OFFERED_TAGS: those named
 * in what the session is about first, then the ones on the sessions most recently worked in.
 */
export function offeredTags(from: OfferFrom): string[] {
  const recent = [...from.sessions].sort((a, b) => b.updatedAt - a.updatedAt).flatMap((s) => s.tags);
  // The first writing of a tag is the one the workspace shows (tags.ts `tagCounts`).
  const firstWritten = new Map<string, string>();
  for (const tag of from.sessions.flatMap((s) => s.tags)) if (!firstWritten.has(tagKey(tag))) firstWritten.set(tagKey(tag), tag);
  const candidates = uniqueTags(recent).filter((t) => !sameTag(t, from.suggested) && !hasTag(from.sessionTags, t));
  const textWords = from.texts.map(tagWords);
  const named = candidates.filter((t) => textWords.some((words) => names(words, t)));
  return [...named, ...candidates.filter((t) => !named.includes(t))].slice(0, OFFERED_TAGS).map((t) => firstWritten.get(tagKey(t)) ?? t);
}

/** Where a session says what it is about, for `offeredTags` and for grounding a new tag. */
export function sessionTexts(session: { title: string; branch?: string | null }, messages: readonly Pick<ChatMessage, 'author' | 'text'>[]): string[] {
  return [...messages.filter((m) => m.author === 'you').map((m) => m.text), session.title, session.branch ?? ''];
}
