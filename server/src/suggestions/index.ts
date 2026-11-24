// Builds the runtime's optional actions: the registry of kinds, the prefs and the service, with the
// runtime as their host (a suggestion is a card in the session's conversation).
import type { ChatMessage } from '../model.ts';
import { suggestionMessageId, type Suggestion } from '../shared/suggestions.ts';
import type { TranscriptAction } from '../transcript.ts';
import type { Workspace } from '../workspace.ts';
import { noteKind } from './note-kind.ts';
import { memorySettings, SuggestionPrefs, type SettingStore } from './prefs.ts';
import { SuggestionRegistry, type SuggestionKind } from './registry.ts';
import { Suggestions } from './service.ts';
import { tagKind } from './tag-kind.ts';

export { Suggestions } from './service.ts';

export interface SuggestionOptions {
  /** Where the tag rules are kept: the store's settings. In memory when absent (tests). */
  settings?: SettingStore;
  /** Also offer the `note` kind, which only tests and the scripted stand-in use. */
  testKinds?: boolean;
  /** Kinds that need the runtime to do their work (the review offer), built by it. */
  kinds?: readonly SuggestionKind[];
}

/** The kinds a session's agent may suggest. */
export const suggestionKinds = (testKinds = false, more: readonly SuggestionKind[] = []): SuggestionRegistry => new SuggestionRegistry([tagKind, ...more, ...(testKinds ? [noteKind] : [])]);

/** What of the runtime the suggestions use. */
export interface SuggestionRuntime {
  snapshot(sessionId: string): Promise<unknown>;
  recordOf(sessionId: string): { messages: ChatMessage[] } | undefined;
  showCard(sessionId: string, card: Extract<TranscriptAction, { type: 'card' }>): void;
}

export function createSuggestions(runtime: SuggestionRuntime, workspace: Workspace, opts: SuggestionOptions = {}): Suggestions {
  return new Suggestions(
    {
      // A stored session is loaded first, so a suggestion can be answered after a restart. One out of
      // sight (archived) has no snapshot; while its record is still held, its line's Undo still works.
      messages: async (id) => {
        await runtime.snapshot(id);
        return runtime.recordOf(id)?.messages ?? null;
      },
      show: (id, suggestion: Suggestion) => runtime.showCard(id, { type: 'card', id: suggestionMessageId(suggestion.id), suggestion }),
    },
    { registry: suggestionKinds(opts.testKinds, opts.kinds), workspace, prefs: new SuggestionPrefs(opts.settings ?? memorySettings()) },
  );
}
