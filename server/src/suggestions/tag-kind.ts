// The first kind of optional action: tag this session with the ticket, release or feature it is
// about. Grounding and the not-annoying rules are in tag-policy.ts; the user's standing answers in
// shared/tag-rules.ts. Buttons: Tag · Always tag sessions with {Source} tickets · Not right now ·
// Don't ask again.
import type { SessionView, WorkspaceState } from '../model.ts';
import { suggestionsIn, type Suggestion } from '../shared/suggestions.ts';
import { alwaysLabel, cleanSource, isRuleValue, isTagCategory, kindLabel, ruleFor, ruleKey, type RuleValue, type TagCategory } from '../shared/tag-rules.ts';
import { hasTag, tagCounts } from '../shared/tags.ts';
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
function textsOf(session: SessionView, ctx: KindContext): string[] {
  const said = ctx.messages.filter((m) => m.author === 'you').map((m) => m.text);
  return [...said, session.title, session.branch ?? ''];
}

function parentTags(state: WorkspaceState, sessionId: string): readonly string[] {
  const parentId = state.links.find((l) => l.childId === sessionId)?.parentId;
  return [...state.sessions, ...state.archived.sessions].find((s) => s.id === parentId)?.tags ?? [];
}

function draftFor(p: TagProposal, tag: string): Extract<Proposal, { type: 'show' }>['draft'] {
  return {
    title: `Tag this session ${tag}?`,
    ...(p.reason ? { reason: p.reason } : {}),
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
  const grounded = groundTag(p.tag, { existingTags: tagCounts(state.sessions).map((t) => t.tag), texts: textsOf(session, ctx) });
  if ('refused' in grounded) return { type: 'refuse', reason: grounded.refused };
  const tagged = { ...p, tag: grounded.tag };
  const earlier = suggestionsIn(ctx.messages).filter((s) => s.kind === 'tag');
  const verdict = tagVerdict(tagged, { prefs: await ctx.prefs.tags(), sessionTags: session.tags, parentTags: parentTags(state, ctx.sessionId), earlier });
  if (verdict.type === 'refuse' || verdict.type === 'skip') return verdict;
  return { type: 'show', draft: draftFor(tagged, grounded.tag), ...(verdict.type === 'auto' ? { apply: TAG_BUTTONS.tag } : {}) };
}

/** Adds the tag; whether it was added (false when the session already had it). */
async function addTag(ctx: KindContext, tag: string): Promise<boolean> {
  const before = (await ctx.workspace.state()).sessions.find((s) => s.id === ctx.sessionId)?.tags ?? [];
  await ctx.workspace.tagSession(ctx.sessionId, tag);
  return !hasTag(before, tag);
}

async function setRule(ctx: KindContext, p: TagPayload, value: RuleValue): Promise<RuleValue> {
  const previous = ruleFor(await ctx.prefs.tags(), p.category, p.source);
  await ctx.prefs.setTagRule(ruleKey(p.category, p.source), value, p.source);
  return previous;
}

async function press(ctx: KindContext, s: Suggestion, button: string): Promise<Pressed> {
  const p = payloadOf(s);
  const kind = kindLabel(p.category, p.source).toLowerCase();
  switch (button) {
    case TAG_BUTTONS.tag:
      return { state: 'answered', line: `Tagged ${p.tag}`, undo: { removeTag: await addTag(ctx, p.tag) } };
    case TAG_BUTTONS.always: {
      const rule = await setRule(ctx, p, 'always');
      return { state: 'answered', line: `Tagged ${p.tag} · always for ${kind}`, undo: { removeTag: await addTag(ctx, p.tag), rule } };
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
  if (s.undo?.removeTag === true) {
    await ctx.workspace.untagSession(ctx.sessionId, p.tag);
    parts.push(`Untagged ${p.tag}`);
  }
  if (isRuleValue(s.undo?.rule)) {
    await ctx.prefs.setTagRule(ruleKey(p.category, p.source), s.undo.rule, p.source);
    parts.push(`${kindLabel(p.category, p.source)} back to ${s.undo.rule === 'ask' ? 'asking' : s.undo.rule}`);
  }
  return parts.join(' · ') || `Tag suggestion for ${p.tag} undone`;
}

export const tagKind: SuggestionKind = { kind: 'tag', dismiss: TAG_BUTTONS.notNow, propose, press, undo };
