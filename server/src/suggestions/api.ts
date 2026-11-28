// HTTP routes for optional actions. Shaped like organize-api.ts: the caller hands over the path parts
// and a body reader, and gets an answer, or null when the path is not one of these. The card itself
// reaches the UI on the session's live channel, like any message.
//
//   POST  /api/sessions/:id/suggestions/:sid/answer   { button, picks?, toggles? }   200 { suggestion }
//   POST  /api/sessions/:id/suggestions/:sid/dismiss                           200 { suggestion }
//   POST  /api/sessions/:id/suggestions/:sid/undo                              200 { suggestion }
//   GET   /api/suggestion-prefs/tags                                           200 { enabled, rules }
//   PATCH /api/suggestion-prefs/tags  { enabled?: boolean, rule?: { key, value } }   200 { enabled, rules }
//   GET   /api/suggestion-prefs/tickets                                        200 { answers }
//   PATCH /api/suggestion-prefs/tickets  { change, source, answer: ask | always | never }  200 { answers }
import { isPicks, isSuggestionId, isToggles } from '../shared/suggestions.ts';
import { isRuleValue, parseRuleKey, ruleRows, type TagSuggestionPrefs } from '../shared/tag-rules.ts';
import { ANSWER_SOURCES, isTicketChange, type AnswerSource } from '../shared/ticket-changes.ts';
import type { Suggestions } from './service.ts';

export type SuggestionAnswer = { status: number; body?: unknown };
type ReadBody = () => Promise<Record<string, unknown>>;

const ACTIONS = new Set(['answer', 'dismiss', 'undo']);
const MAX_KEY = 120;

const prefsView = (prefs: TagSuggestionPrefs) => ({ enabled: prefs.enabled, rules: ruleRows(prefs) });
const bad = (error: string): SuggestionAnswer => ({ status: 400, body: { error } });

export async function suggestionRoute(parts: readonly string[], method: string, readBody: ReadBody, suggestions: Suggestions): Promise<SuggestionAnswer | null> {
  if (parts[1] === 'suggestion-prefs' && parts[2] === 'tags' && parts.length === 3) return prefsRoute(method, readBody, suggestions);
  if (parts[1] === 'suggestion-prefs' && parts[2] === 'tickets' && parts.length === 3) return ticketAnswersRoute(method, readBody, suggestions);
  if (parts[1] !== 'sessions' || parts[3] !== 'suggestions' || parts.length !== 6 || method !== 'POST' || !ACTIONS.has(parts[5]!)) return null;
  const [sessionId, suggestionId, action] = [parts[2]!, parts[4]!, parts[5]!];
  if (!isSuggestionId(suggestionId)) return bad('The suggestion id is not valid.');
  if (action === 'answer') {
    const { button, picks, toggles } = await readBody();
    if (!isSuggestionId(button)) return bad('button must be one of the suggestion\'s button ids.');
    if (picks !== undefined && !isPicks(picks)) return bad('picks must be a short list of names.');
    if (toggles !== undefined && !isToggles(toggles)) return bad('toggles must be a short list of the button\'s choices.');
    return { status: 200, body: { suggestion: await suggestions.answer(sessionId, suggestionId, button, picks, toggles) } };
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

/** Settings → Tickets: the standing answers to ticket changes, each settable back to Ask. */
async function ticketAnswersRoute(method: string, readBody: ReadBody, suggestions: Suggestions): Promise<SuggestionAnswer | null> {
  if (method === 'GET') return { status: 200, body: { answers: await suggestions.prefs.ticketAnswers() } };
  if (method !== 'PATCH') return null;
  const body = await readBody();
  if (!isTicketChange(body.change)) return bad('change must be in-progress, in-review or comment.');
  if (!(ANSWER_SOURCES as readonly unknown[]).includes(body.source)) return bad('source is not a ticket source.');
  if (body.answer !== 'ask' && body.answer !== 'always' && body.answer !== 'never') return bad('answer must be ask, always or never.');
  const answers = await suggestions.prefs.setTicketAnswer(body.change, body.source as AnswerSource, body.answer === 'ask' ? null : body.answer);
  return { status: 200, body: { answers } };
}
