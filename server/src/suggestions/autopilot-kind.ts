// The Autopilot offer (docs/designs/pr-autopilot.md): raised by Kestrel only, when a session's pull request
// first appears and the Create pull request form did not already ask. "Turn on" carries two choices as one
// group (`toggles`): Merge it when it is green, and Watch the target branch's pipeline after merging; the
// answer says which were ticked. An older client that knows only the single `toggle` (Merge it when it is
// green: ticked, the button sends `on-merge`) still turns it on, with the watch as Settings says. Not now;
// Don't ask again, which switches the offer off in Settings → Git → Autopilot. It never starts a turn by itself.
import { hostTerms, isHostKind, requestNumber } from '../shared/host-terms.ts';
import { watchLabel, type AutopilotChoice, type AutopilotPrefs } from '../shared/autopilot.ts';
import type { Pressed, Proposal, SuggestionKind } from './registry.ts';

export const AUTOPILOT_KIND = 'autopilot';
export const AUTOPILOT_SETTING = 'Settings → Git → Autopilot';

export interface AutopilotKindDeps {
  prefs(): Promise<AutopilotPrefs>;
  turnOn(sessionId: string, choice: AutopilotChoice, number: number): Promise<unknown>;
  stopOffering(): Promise<unknown>;
  /** Whether the session's mode asks before each change (Manual): the card says rounds will ask too. */
  asks(sessionId: string): Promise<boolean>;
}

interface Offer {
  host: 'github' | 'gitlab';
  number: number;
  /** The request's target branch, when the PR store knew it: the watch's choice names it. */
  base?: string;
}

const asOffer = (p: Record<string, unknown>): Offer | null =>
  isHostKind(p.host) && typeof p.number === 'number' ? { host: p.host, number: p.number, ...(typeof p.base === 'string' && p.base ? { base: p.base.slice(0, 200) } : {}) } : null;

/** The ids of the Turn on button's choices. */
export const AUTOPILOT_TOGGLES = { merge: 'merge', watch: 'watch' } as const;

/** What a press of Turn on chose: the ticked `toggles`, or, from an older client, the `on-merge` button and the watch as Settings says. */
export function choiceOf(button: string, toggles: readonly string[] | undefined, prefs: AutopilotPrefs): AutopilotChoice {
  if (toggles) return { merge: toggles.includes(AUTOPILOT_TOGGLES.merge), watch: toggles.includes(AUTOPILOT_TOGGLES.watch) };
  return { merge: button === 'on-merge', watch: prefs.watch };
}

/** The line left once it is turned on. */
function onLine(where: string, choice: AutopilotChoice, base: string | undefined): string {
  const parts = [choice.merge ? 'merges it when it is green' : '', choice.watch ? `watches ${base ? `the ${base}` : 'the target branch’s'} pipeline after merging` : ''].filter(Boolean);
  return `Autopilot is looking after ${where}${parts.length ? `, and ${parts.join(' and ')}` : ''}`;
}

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
            {
              id: 'on',
              label: 'Turn on',
              primary: true,
              toggle: { id: 'on-merge', label: 'Merge it when it is green', checked: prefs.merge },
              toggles: [
                { id: AUTOPILOT_TOGGLES.merge, label: 'Merge it when it is green', checked: prefs.merge },
                { id: AUTOPILOT_TOGGLES.watch, label: watchLabel(offer.base), checked: prefs.watch },
              ],
            },
            { id: 'on-merge', label: 'Turn on and merge when green', folded: true },
            { id: 'later', label: 'Not now' },
            { id: 'never', label: 'Don’t ask again' },
          ],
        },
      };
    },
    async press(ctx, suggestion, button, _picks, toggles): Promise<Pressed> {
      const offer = asOffer(suggestion.payload);
      if (!offer) throw new Error('The card no longer says which request it is about.');
      const where = requestNumber(hostTerms(offer.host), offer.number);
      if (button === 'on' || button === 'on-merge') {
        const choice = choiceOf(button, toggles, await deps.prefs());
        await deps.turnOn(ctx.sessionId, choice, offer.number);
        return { state: 'answered', line: onLine(where, choice, offer.base) };
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
