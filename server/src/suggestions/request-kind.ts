// The card shown when a session's pull request needs the user (shared/request-attention.ts): its checks
// failed, it has merge conflicts with its target, or a reviewer asked for changes. Raised by Kestrel
// only, never by an agent, when the session is idle (pull-requests/attention-watch.ts), one card per
// reason and occurrence: a failing commit, a commit that conflicts, a review that asks for changes. It
// never blocks and never starts a turn by itself. Its main button sends the session a message as a turn
// the user started (`fixMessage`); "Dismiss" leaves it; "Don't ask again" stops that reason's card, the
// same stored choice as Settings → Git → Pull requests that need you. It withdraws itself when its
// reason no longer holds (`settledLine`). Room is left for an "always" standing answer.
import { fixMessage, isAttentionReason, reasonLine, type AttentionPrefs, type AttentionReason, type ReasonDetail, type RequestAttention } from '../shared/request-attention.ts';
import { hostTerms, isHostKind, requestNumber } from '../shared/host-terms.ts';
import type { Suggestion } from '../shared/suggestions.ts';
import type { Pressed, Proposal, SuggestionKind } from './registry.ts';

export const REQUEST_KIND = 'pull-request';
export const ATTENTION_SETTING = 'Settings → Git → Pull requests that need you';

/** What one card is about: the request, and one reason with its occurrence. */
export type AttentionCard = Omit<RequestAttention, 'reasons'> & ReasonDetail;

export interface RequestKindDeps {
  /** Sends the session a message as the user, starting a turn (or queued behind the one running). */
  send(sessionId: string, text: string): Promise<unknown>;
  /** What the session's request needs now, whatever the session is doing; undefined when the store has no answer. */
  current(sessionId: string): Promise<RequestAttention | null | undefined>;
  prefs(): Promise<AttentionPrefs>;
  /** "Don't ask again": that reason's card is no longer offered. */
  stopOffering(reason: AttentionReason): Promise<unknown>;
}

const isNamed = (v: unknown): boolean => typeof v === 'object' && v !== null && typeof (v as { name?: unknown }).name === 'string';
const isText = (v: unknown): boolean => typeof v === 'object' && v !== null && typeof (v as { body?: unknown }).body === 'string';

/** The payload Kestrel raised, read back; null when it is not one. */
export function asCard(p: Record<string, unknown>): AttentionCard | null {
  if (!isAttentionReason(p.reason) || typeof p.occurrence !== 'string' || !isHostKind(p.host) || typeof p.number !== 'number' || typeof p.commit !== 'string' || typeof p.title !== 'string' || typeof p.url !== 'string') return null;
  if (p.reason === 'checks-failed' && !(Array.isArray(p.checks) && p.checks.every(isNamed))) return null;
  if (p.reason === 'changes-requested' && !(Array.isArray(p.reviewers) && Array.isArray(p.comments) && p.comments.every(isText))) return null;
  return p as unknown as AttentionCard;
}

/** The most review comments listed on the card itself; the message the agent gets carries more. */
const COMMENTS_ON_CARD = 5;
const linkText = (text: string): string => text.replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();

/** What is drawn under the card's title, as Markdown with links. */
function detailOf(c: AttentionCard): string | undefined {
  if (c.reason === 'checks-failed') {
    const lines = c.checks.map((k) => (k.url ? `- [${linkText(k.name)}](${k.url})` : `- ${k.name}`));
    if (c.checksUrl) lines.push(c.checks.length > 0 ? `- [All checks](${c.checksUrl})` : `- [See the checks](${c.checksUrl})`);
    return lines.length > 0 ? lines.join('\n') : undefined;
  }
  if (c.reason === 'conflicts') return c.url ? `- [The ${hostTerms(c.host).long}](${c.url})` : undefined;
  const review = c.reviewUrl ? [`- [The review](${c.reviewUrl})`] : [];
  const comments = c.comments.slice(0, COMMENTS_ON_CARD).map((k) => {
    const where = k.path ? `${k.path}${k.line ? `:${k.line}` : ''}` : linkText(k.body).slice(0, 60);
    return k.url ? `- [${linkText(where)}](${k.url})` : `- ${where}`;
  });
  const more = c.comments.length > COMMENTS_ON_CARD ? [`- …and ${c.comments.length - COMMENTS_ON_CARD} more comments`] : [];
  const lines = [...review, ...comments, ...more];
  return lines.length > 0 ? lines.join('\n') : undefined;
}

interface ReasonWords {
  button: string;
  /** What the main button does, after the request's title. */
  explains: (c: AttentionCard) => string;
  /** The line a card leaves once it was used: "Asked the agent to …". */
  asked: string;
  /** "Failed checks", for "… left as they are" and "… will not be offered again". */
  name: string;
  /** Why Fix is refused once the reason has gone: "… on #431". */
  gone: string;
}

const WORDS: Record<AttentionReason, ReasonWords> = {
  'checks-failed': { button: 'Fix them', explains: () => 'Fix them asks the agent to read their logs and fix them', asked: 'fix the failed checks', name: 'Failed checks', gone: 'the checks are no longer failing on that commit' },
  conflicts: {
    button: 'Resolve them',
    explains: (c) => `Resolve them asks the agent to merge ${c.reason === 'conflicts' && c.base ? c.base : 'its target'} into this branch here and resolve them, without force-pushing`,
    asked: 'resolve the merge conflicts',
    name: 'Merge conflicts',
    gone: 'it no longer has those conflicts',
  },
  'changes-requested': { button: 'Address them', explains: () => 'Address them gives the agent the review and its comments to work through; it replies to nobody on the host', asked: 'address the requested changes', name: 'Requested changes', gone: 'that review no longer asks for changes' },
};

/** Whether a suggestion is this kind's card for that request, reason and occurrence. */
export const isCardFor = (s: Pick<Suggestion, 'kind' | 'payload'>, c: Pick<AttentionCard, 'number' | 'reason' | 'occurrence'>): boolean =>
  s.kind === REQUEST_KIND && s.payload.number === c.number && s.payload.reason === c.reason && s.payload.occurrence === c.occurrence;

export function requestKind(deps: RequestKindDeps): SuggestionKind {
  return {
    kind: REQUEST_KIND,
    dismiss: 'dismiss',
    kestrelOnly: true,
    async propose(ctx, payload): Promise<Proposal> {
      const c = asCard(payload);
      if (!c) return { type: 'refuse', reason: 'Not a card about a pull request that needs the user.' };
      const prefs = (await deps.prefs())[c.reason];
      if (!prefs.watch || prefs.card === 'never') return { type: 'skip', text: `The user turned this card off in ${ATTENTION_SETTING}.` };
      if (ctx.messages.some((m) => m.suggestion && isCardFor(m.suggestion, c))) return { type: 'skip', text: 'This already had a card.' };
      const detail = detailOf(c);
      const words = WORDS[c.reason];
      // No standing "always" yet: the card is always shown. That answer would press 'fix' here (`apply`).
      return {
        type: 'show',
        draft: {
          title: reasonLine(c, c),
          reason: `“${c.title}”. ${words.explains(c)}; nothing starts until you choose.`,
          ...(detail ? { detail } : {}),
          payload: { ...c },
          buttons: [
            { id: 'fix', label: words.button, primary: true },
            { id: 'dismiss', label: 'Dismiss' },
            { id: 'never', label: 'Don’t ask again' },
          ],
        },
      };
    },
    async press(ctx, suggestion, button): Promise<Pressed> {
      const c = asCard(suggestion.payload);
      if (!c) throw new Error('The card no longer says what the pull request needs.');
      const where = requestNumber(hostTerms(c.host), c.number);
      const words = WORDS[c.reason];
      if (button === 'fix') {
        const now = await deps.current(ctx.sessionId);
        const holds = now === undefined || (now !== null && now.number === c.number && now.reasons.some((d) => d.reason === c.reason && d.occurrence === c.occurrence));
        if (!holds) throw new Error(`${where}: ${words.gone}`);
        await deps.send(ctx.sessionId, fixMessage(c, c));
        return { state: 'answered', line: `Asked the agent to ${words.asked} on ${where}` };
      }
      if (button === 'dismiss') return { state: 'dismissed', line: `${words.name} on ${where} left as they are` };
      if (button === 'never') {
        await deps.stopOffering(c.reason);
        return { state: 'answered', line: `${words.name} will not be offered again. Turn the card back on in ${ATTENTION_SETTING}.` };
      }
      throw new Error(`This card has no button "${button}".`);
    },
  };
}
