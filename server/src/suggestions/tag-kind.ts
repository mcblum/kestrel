// The first kind of optional action: tag this session with the ticket, release or feature it is
// about. Grounding and the not-annoying rules are in tag-policy.ts; the user's standing answers in
// shared/tag-rules.ts. Buttons: Tag · Always tag sessions with {Source} tickets · Not right now ·
// Don't ask again. The card also offers a few existing tags and takes typed ones (`picks`): Tag and
// Always add whatever the user chose, and with no choice sent (a phone) the suggested tag.
import type { SessionView, WorkspaceState } from '../model.ts';
import { suggestionsIn, type Suggestion } from '../shared/suggestions.ts';
import { alwaysLabel, cleanSource, isRuleValue, isTagCategory, kindLabel, ruleFor, ruleKey, type RuleValue, type TagCategory } from '../shared/tag-rules.ts';
import { offeredTags, pickedTags, sessionTexts } from '../shared/tag-match.ts';
import { hasTag, mostUsedTags } from '../shared/tags.ts';
import { Refused } from '../workspace.ts';
import type { KindContext, Pressed, Proposal, SuggestionKind } from './registry.ts';
import { groundTag, parseTagProposal, tagVerdict, type TagProposal } from './tag-policy.ts';

export const TAG_BUTTONS = { tag: 'tag', always: 'always', notNow: 'not-now', never: 'never' } as const;
export const DISMISSED_LINE = 'Tag suggestion dismissed';

interface TagPayload {
  tag: string;
  category: TagCategory;
  source: string | null;
}

function payloadOf(s: Suggestion): TagPayload {
  const { tag, category, source } = s.payload;
  if (typeof tag !== 'string' || !isTagCategory(category)) throw new Error('This tag suggestion is damaged.');
  return { tag, category, source: cleanSource(source) };
}

/** Where a new tag may be named: the user's messages, the title, the branch. */
const textsOf = (session: SessionView, ctx: KindContext): string[] => sessionTexts(session, ctx.messages);

function parentTags(state: WorkspaceState, sessionId: string): readonly string[] {
  const parentId = state.links.find((l) => l.childId === sessionId)?.parentId;
  return [...state.sessions, ...state.archived.sessions].find((s) => s.id === parentId)?.tags ?? [];
}

function draftFor(p: TagProposal, tag: string, offered: string[]): Extract<Proposal, { type: 'show' }>['draft'] {
  return {
    title: `Tag this session ${tag}?`,
    ...(p.reason ? { reason: p.reason } : {}),
    picks: { of: 'tag', chosen: [tag], offered, buttons: [TAG_BUTTONS.tag, TAG_BUTTONS.always] },
    payload: { tag, category: p.category, source: p.source },
    buttons: [
      { id: TAG_BUTTONS.tag, label: 'Tag', primary: true },
      { id: TAG_BUTTONS.always, label: alwaysLabel(p.category, p.source) },
      { id: TAG_BUTTONS.notNow, label: 'Not right now' },
      { id: TAG_BUTTONS.never, label: "Don't ask again" },
    ],
  };
}

async function propose(ctx: KindContext, raw: Record<string, unknown>): Promise<Proposal> {
  const p = parseTagProposal(raw);
  if (!('tag' in p)) return { type: 'refuse', reason: p.reason };
  const state = await ctx.workspace.state();
  const session = state.sessions.find((s) => s.id === ctx.sessionId);
  if (!session) return { type: 'refuse', reason: 'This session is not in the workspace (archived or deleted).' };
  const texts = textsOf(session, ctx);
  const grounded = groundTag(p.tag, { existingTags: mostUsedTags(state.sessions), texts });
  if ('refused' in grounded) return { type: 'refuse', reason: grounded.refused };
  const tagged = { ...p, tag: grounded.tag };
  const earlier = suggestionsIn(ctx.messages).filter((s) => s.kind === 'tag');
  const verdict = tagVerdict(tagged, { prefs: await ctx.prefs.tags(), sessionTags: session.tags, parentTags: parentTags(state, ctx.sessionId), earlier });
  if (verdict.type === 'refuse' || verdict.type === 'skip') return verdict;
  const offered = offeredTags({ suggested: grounded.tag, sessionTags: session.tags, sessions: state.sessions, texts });
  return { type: 'show', draft: draftFor(tagged, grounded.tag, offered), ...(verdict.type === 'auto' ? { apply: TAG_BUTTONS.tag } : {}) };
}

/**
 * Adds the tags the user chose on the card, or the suggested one when the answer chose none (a phone,
 * a standing rule). What was asked for and which of them the session did not have yet (Undo's part).
 */
async function addTags(ctx: KindContext, p: TagPayload, picks: readonly string[] | undefined): Promise<{ tags: string[]; added: string[] }> {
  const sessions = (await ctx.workspace.state()).sessions;
  const picked = picks ? pickedTags(picks, mostUsedTags(sessions)) : { tags: [p.tag] };
  if ('reason' in picked) throw new Refused(picked.reason);
  const before = sessions.find((s) => s.id === ctx.sessionId)?.tags ?? [];
  for (const tag of picked.tags) await ctx.workspace.tagSession(ctx.sessionId, tag);
  return { tags: picked.tags, added: picked.tags.filter((tag) => !hasTag(before, tag)) };
}

async function setRule(ctx: KindContext, p: TagPayload, value: RuleValue): Promise<RuleValue> {
  const previous = ruleFor(await ctx.prefs.tags(), p.category, p.source);
  await ctx.prefs.setTagRule(ruleKey(p.category, p.source), value, p.source);
  return previous;
}

async function press(ctx: KindContext, s: Suggestion, button: string, picks?: readonly string[]): Promise<Pressed> {
  const p = payloadOf(s);
  const kind = kindLabel(p.category, p.source).toLowerCase();
  switch (button) {
    case TAG_BUTTONS.tag: {
      const { tags, added } = await addTags(ctx, p, picks);
      return { state: 'answered', line: `Tagged ${tags.join(', ')}`, undo: { tags: added } };
    }
    case TAG_BUTTONS.always: {
      // The tags first: a refused choice must not leave the rule changed.
      const { tags, added } = await addTags(ctx, p, picks);
      const rule = await setRule(ctx, p, 'always');
      return { state: 'answered', line: `Tagged ${tags.join(', ')} · always for ${kind}`, undo: { tags: added, rule } };
    }
    case TAG_BUTTONS.never:
      return { state: 'answered', line: `Tag suggestions for ${kind} turned off`, undo: { rule: await setRule(ctx, p, 'never') } };
    case TAG_BUTTONS.notNow:
      return { state: 'dismissed', line: DISMISSED_LINE };
    default:
      throw new Error(`A tag suggestion has no button "${button}".`);
  }
}

async function undo(ctx: KindContext, s: Suggestion): Promise<string> {
  const p = payloadOf(s);
  const parts: string[] = [];
  // `removeTag` is how an answer stored before the card took several tags says it added the suggested one.
  const added = Array.isArray(s.undo?.tags) ? s.undo.tags.filter((t): t is string => typeof t === 'string') : s.undo?.removeTag === true ? [p.tag] : [];
  for (const tag of added) await ctx.workspace.untagSession(ctx.sessionId, tag);
  if (added.length) parts.push(`Untagged ${added.join(', ')}`);
  if (isRuleValue(s.undo?.rule)) {
    await ctx.prefs.setTagRule(ruleKey(p.category, p.source), s.undo.rule, p.source);
    parts.push(`${kindLabel(p.category, p.source)} back to ${s.undo.rule === 'ask' ? 'asking' : s.undo.rule}`);
  }
  return parts.join(' · ') || `Tag suggestion for ${p.tag} undone`;
}

export const tagKind: SuggestionKind = { kind: 'tag', dismiss: TAG_BUTTONS.notNow, propose, press, undo };
