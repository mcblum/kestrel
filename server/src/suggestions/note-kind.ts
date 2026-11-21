// The smallest kind of optional action: a note with one "Got it" button. It exists to prove a second
// kind needs only a registry entry. Used by tests and the scripted stand-in (fake mode); never
// offered to a real agent (see `suggestionKinds`).
import type { Pressed, Proposal, SuggestionKind } from './registry.ts';

const TEXT_MAX = 200;

export const noteKind: SuggestionKind = {
  kind: 'note',
  dismiss: 'dismiss',
  async propose(_ctx, raw): Promise<Proposal> {
    const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, TEXT_MAX) : '';
    if (!text) return { type: 'refuse', reason: 'text is empty.' };
    return { type: 'show', draft: { title: text, payload: { text }, buttons: [{ id: 'ok', label: 'Got it', primary: true }] } };
  },
  async press(_ctx, s, button): Promise<Pressed> {
    if (button === 'ok') return { state: 'answered', line: `Noted: ${String(s.payload.text)}` };
    if (button === 'dismiss') return { state: 'dismissed', line: 'Note dismissed' };
    throw new Error(`A note has no button "${button}".`);
  },
};
