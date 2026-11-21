// HTTP routes for optional actions. Shaped like organize-api.ts: the caller hands over the path parts
// and a body reader, and gets an answer, or null when the path is not one of these. The card itself
// reaches the UI on the session's live channel, like any message.
//
//   POST  /api/sessions/:id/suggestions/:sid/answer   { button }               200 { suggestion }
//   POST  /api/sessions/:id/suggestions/:sid/dismiss                           200 { suggestion }
//   POST  /api/sessions/:id/suggestions/:sid/undo                              200 { suggestion }
//   GET   /api/suggestion-prefs/tags                                           200 { enabled, rules }
//   PATCH /api/suggestion-prefs/tags  { enabled?: boolean, rule?: { key, value } }   200 { enabled, rules }
import { isSuggestionId } from '../shared/suggestions.ts';
import { isRuleValue, parseRuleKey, ruleRows, type TagSuggestionPrefs } from '../shared/tag-rules.ts';
import type { Suggestions } from './service.ts';

export type SuggestionAnswer = { status: number; body?: unknown };
type ReadBody = () => Promise<Record<string, unknown>>;

const ACTIONS = new Set(['answer', 'dismiss', 'undo']);
const MAX_KEY = 120;

const prefsView = (prefs: TagSuggestionPrefs) => ({ enabled: prefs.enabled, rules: ruleRows(prefs) });
const bad = (error: string): SuggestionAnswer => ({ status: 400, body: { error } });

export async function suggestionRoute(parts: readonly string[], method: string, readBody: ReadBody, suggestions: Suggestions): Promise<SuggestionAnswer | null> {
  if (parts[1] === 'suggestion-prefs' && parts[2] === 'tags' && parts.length === 3) return prefsRoute(method, readBody, suggestions);
  if (parts[1] !== 'sessions' || parts[3] !== 'suggestions' || parts.length !== 6 || method !== 'POST' || !ACTIONS.has(parts[5]!)) return null;
  const [sessionId, suggestionId, action] = [parts[2]!, parts[4]!, parts[5]!];
  if (!isSuggestionId(suggestionId)) return bad('The suggestion id is not valid.');
  if (action === 'answer') {
    const button = (await readBody()).button;
    if (!isSuggestionId(button)) return bad('button must be one of the suggestion\'s button ids.');
    return { status: 200, body: { suggestion: await suggestions.answer(sessionId, suggestionId, button) } };
  }
  const suggestion = action === 'dismiss' ? await suggestions.dismiss(sessionId, suggestionId) : await suggestions.undo(sessionId, suggestionId);
  return { status: 200, body: { suggestion } };
}

async function prefsRoute(method: string, readBody: ReadBody, suggestions: Suggestions): Promise<SuggestionAnswer | null> {
  if (method === 'GET') return { status: 200, body: prefsView(await suggestions.prefs.tags()) };
  if (method !== 'PATCH') return null;
  const body = await readBody();
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') return bad('enabled must be true or false.');
  const rule = body.rule as { key?: unknown; value?: unknown } | undefined;
  if (rule !== undefined) {
    if (typeof rule !== 'object' || rule === null) return bad('rule must be { key, value }.');
    if (typeof rule.key !== 'string' || rule.key.length > MAX_KEY || !parseRuleKey(rule.key)) return bad('rule.key is not a tag rule.');
    if (!isRuleValue(rule.value)) return bad('rule.value must be ask, always or never.');
  }
  let prefs = await suggestions.prefs.tags();
  if (typeof body.enabled === 'boolean') prefs = await suggestions.prefs.setTagsEnabled(body.enabled);
  if (rule) prefs = await suggestions.prefs.setTagRule(rule.key as string, rule.value as never);
  return { status: 200, body: prefsView(prefs) };
}
