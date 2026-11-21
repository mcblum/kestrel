// Where the answers that outlive one suggestion are kept: the tag rules and the "Suggest tags"
// switch (shared/tag-rules.ts), in the store's small named settings, so both persistence backends
// keep them. Writes run one after another, so two quick changes never lose one.
import { sanitizeTagPrefs, withRule, type RuleValue, type TagSuggestionPrefs } from '../shared/tag-rules.ts';

/** The part of Persistence this needs; tests and the in-memory default pass their own. */
export interface SettingStore {
  getSetting(key: string): Promise<string | null>;
  putSetting(key: string, value: string): Promise<void>;
}

export const TAG_PREFS_KEY = 'tag-suggestions';

/** Settings kept in memory only, for a runtime started without a store (tests). */
export function memorySettings(): SettingStore {
  let values = new Map<string, string>();
  return {
    getSetting: async (key) => values.get(key) ?? null,
    putSetting: async (key, value) => {
      values = new Map(values).set(key, value);
    },
  };
}

export class SuggestionPrefs {
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: SettingStore) {}

  async tags(): Promise<TagSuggestionPrefs> {
    const raw = await this.store.getSetting(TAG_PREFS_KEY);
    if (!raw) return sanitizeTagPrefs(null);
    try {
      return sanitizeTagPrefs(JSON.parse(raw));
    } catch {
      return sanitizeTagPrefs(null); // unreadable: the defaults, and the next write replaces it
    }
  }

  setTagRule(key: string, value: RuleValue, source?: string | null): Promise<TagSuggestionPrefs> {
    return this.change((prefs) => withRule(prefs, key, value, source));
  }

  setTagsEnabled(enabled: boolean): Promise<TagSuggestionPrefs> {
    return this.change((prefs) => ({ ...prefs, enabled }));
  }

  private change(next: (prefs: TagSuggestionPrefs) => TagSuggestionPrefs): Promise<TagSuggestionPrefs> {
    const work = this.writes.then(async () => {
      const updated = next(await this.tags());
      await this.store.putSetting(TAG_PREFS_KEY, JSON.stringify(updated));
      return updated;
    });
    this.writes = work.catch(() => undefined);
    return work;
  }
}
