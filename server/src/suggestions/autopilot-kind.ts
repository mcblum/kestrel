// The Autopilot offer (docs/designs/pr-autopilot.md): raised by Kestrel only, when a session's pull request
// first appears and the Create pull request form did not already ask. "Turn on" carries a checkbox, Merge it
// when it is green (`toggle`: ticked, the button sends `on-merge`); Not now; Don't ask again, which switches
// the offer off in Settings → Git → Autopilot. It never starts a turn by itself.
import { hostTerms, isHostKind, requestNumber } from '../shared/host-terms.ts';
import type { AutopilotPrefs } from '../shared/autopilot.ts';
import type { Pressed, Proposal, SuggestionKind } from './registry.ts';

export const AUTOPILOT_KIND = 'autopilot';
export const AUTOPILOT_SETTING = 'Settings → Git → Autopilot';

export interface AutopilotKindDeps {
  prefs(): Promise<AutopilotPrefs>;
  turnOn(sessionId: string, merge: boolean, number: number): Promise<unknown>;
  stopOffering(): Promise<unknown>;
  /** Whether the session's mode asks before each change (Manual): the card says rounds will ask too. */
  asks(sessionId: string): Promise<boolean>;
}

interface Offer {
  host: 'github' | 'gitlab';
  number: number;
}

const asOffer = (p: Record<string, unknown>): Offer | null => (isHostKind(p.host) && typeof p.number === 'number' ? { host: p.host, number: p.number } : null);

export function autopilotKind(deps: AutopilotKindDeps): SuggestionKind {
  return {
    kind: AUTOPILOT_KIND,
    dismiss: 'later',
    kestrelOnly: true,
    async propose(ctx, payload): Promise<Proposal> {
      const offer = asOffer(payload);
      if (!offer) return { type: 'refuse', reason: 'Not an Autopilot offer.' };
      const prefs = await deps.prefs();
      if (!prefs.offer) return { type: 'skip', text: `The user turned the Autopilot offer off in ${AUTOPILOT_SETTING}.` };
      if (ctx.messages.some((m) => m.suggestion?.kind === AUTOPILOT_KIND && m.suggestion.payload.number === offer.number)) return { type: 'skip', text: 'This request was already offered Autopilot.' };
      const terms = hostTerms(offer.host);
      const where = requestNumber(terms, offer.number);
      const manual = (await deps.asks(ctx.sessionId)) ? ' This session is in Manual, so the agent still asks before each change.' : '';
      return {
        type: 'show',
        draft: {
          title: `Look after ${terms.long} ${where}?`,
          reason: `Autopilot watches its checks. When they fail, it conflicts or a reviewer asks for changes, the agent fixes it and pushes, up to ${prefs.rounds} ${prefs.rounds === 1 ? 'round' : 'rounds'}, then stops and tells you. Send a message any time to take over.${manual}`,
          payload: { ...offer },
          buttons: [
            { id: 'on', label: 'Turn on', primary: true, toggle: { id: 'on-merge', label: 'Merge it when it is green', checked: prefs.merge } },
            { id: 'on-merge', label: 'Turn on and merge when green', folded: true },
            { id: 'later', label: 'Not now' },
            { id: 'never', label: 'Don’t ask again' },
          ],
        },
      };
    },
    async press(ctx, suggestion, button): Promise<Pressed> {
      const offer = asOffer(suggestion.payload);
      if (!offer) throw new Error('The card no longer says which request it is about.');
      const where = requestNumber(hostTerms(offer.host), offer.number);
      if (button === 'on' || button === 'on-merge') {
        await deps.turnOn(ctx.sessionId, button === 'on-merge', offer.number);
        return { state: 'answered', line: button === 'on-merge' ? `Autopilot is looking after ${where}, and merges it when it is green` : `Autopilot is looking after ${where}` };
      }
      if (button === 'later') return { state: 'dismissed', line: `Autopilot left off for ${where}` };
      if (button === 'never') {
        await deps.stopOffering();
        return { state: 'answered', line: `Autopilot will not be offered again. Turn the offer back on in ${AUTOPILOT_SETTING}.` };
      }
      throw new Error(`This card has no button "${button}".`);
    },
  };
}
