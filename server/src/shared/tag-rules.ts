// The user's standing answers to tag suggestions, stored as prefs. A rule is kept per kind of tag:
// its category (ticket, release, feature) and where it comes from (Jira, Linear, Monday…, free text,
// compared without case; none given is "any"). Each rule is Ask (the default), Always (tag at once,
// no card) or Never (not shown). One master switch turns tag suggestions off altogether. Pure and
// shared with the UI (the Settings page lists the rules).

export const TAG_CATEGORIES = ['ticket', 'release', 'feature'] as const;
export type TagCategory = (typeof TAG_CATEGORIES)[number];

export const RULE_VALUES = ['ask', 'always', 'never'] as const;
export type RuleValue = (typeof RULE_VALUES)[number];
export const RULE_LABEL: Record<RuleValue, string> = { ask: 'Ask', always: 'Always', never: 'Never' };

/** The rule key's source part when the model named none. */
export const ANY_SOURCE = 'any';
const SOURCE_MAX = 40;
const MAX_RULES = 200;

export interface TagRule {
  value: RuleValue;
  /** The source as first written ("Jira"), for labels; absent for "any". */
  source?: string;
}

export interface TagSuggestionPrefs {
  /** "Suggest tags": off, the tool refuses and the title call's candidates are ignored. */
  enabled: boolean;
  rules: Readonly<Record<string, TagRule>>;
}

export const DEFAULT_TAG_PREFS: TagSuggestionPrefs = { enabled: true, rules: {} };

export const isTagCategory = (value: unknown): value is TagCategory => typeof value === 'string' && (TAG_CATEGORIES as readonly string[]).includes(value);
export const isRuleValue = (value: unknown): value is RuleValue => typeof value === 'string' && (RULE_VALUES as readonly string[]).includes(value);

/** A source as written, cleaned: trimmed, one space inside, at most SOURCE_MAX characters; null when there is none. */
export function cleanSource(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const source = raw.trim().replace(/\s+/g, ' ').slice(0, SOURCE_MAX);
  return source && source.toLowerCase() !== ANY_SOURCE ? source : null;
}

/** The key a rule is stored under: `category:source`, the source without case, "any" when none. */
export const ruleKey = (category: TagCategory, source?: string | null): string => `${category}:${(cleanSource(source) ?? ANY_SOURCE).toLowerCase()}`;

/** A stored key read back, or null when it is not one. */
export function parseRuleKey(key: string): { category: TagCategory; source: string } | null {
  const at = key.indexOf(':');
  const category = key.slice(0, at);
  const source = key.slice(at + 1);
  return at > 0 && isTagCategory(category) && source ? { category, source } : null;
}

/** The rule for a kind of tag: exactly its own key (a rule for "any" does not cover a named source). Ask when none is stored. */
export const ruleFor = (prefs: TagSuggestionPrefs, category: TagCategory, source?: string | null): RuleValue => prefs.rules[ruleKey(category, source)]?.value ?? 'ask';

/** `prefs` with one rule set; Ask removes the rule (it is the default). */
export function withRule(prefs: TagSuggestionPrefs, key: string, value: RuleValue, source?: string | null): TagSuggestionPrefs {
  const rest = Object.fromEntries(Object.entries(prefs.rules).filter(([k]) => k !== key));
  const written = cleanSource(source) ?? prefs.rules[key]?.source;
  return { ...prefs, rules: value === 'ask' ? rest : { ...rest, [key]: { value, ...(written ? { source: written } : {}) } } };
}

/** Stored prefs as they can be trusted: anything unknown is dropped. */
export function sanitizeTagPrefs(raw: unknown): TagSuggestionPrefs {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return DEFAULT_TAG_PREFS;
  const value = raw as { enabled?: unknown; rules?: unknown };
  const rules = typeof value.rules === 'object' && value.rules !== null && !Array.isArray(value.rules) ? value.rules : {};
  const kept = Object.entries(rules)
    .filter(([key, rule]) => parseRuleKey(key) && isRuleValue((rule as TagRule | null)?.value) && (rule as TagRule).value !== 'ask')
    .slice(0, MAX_RULES)
    .map(([key, rule]) => {
      const source = cleanSource((rule as TagRule).source);
      return [key, { value: (rule as TagRule).value, ...(source ? { source } : {}) }] as const;
    });
  return { enabled: value.enabled !== false, rules: Object.fromEntries(kept) };
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** What a kind of tag is called: "Jira tickets", "Tickets", "Releases", "Linear feature tags". */
export function kindLabel(category: TagCategory, source?: string | null): string {
  const shown = cleanSource(source);
  const noun = category === 'ticket' ? 'tickets' : category === 'release' ? 'release tags' : 'feature tags';
  if (shown) return `${shown} ${noun}`;
  return category === 'ticket' ? 'Tickets' : category === 'release' ? 'Releases' : 'Feature tags';
}

/** The "Always…" button: "Always tag sessions with Jira tickets", "…with release tags", "…with tickets". */
export function alwaysLabel(category: TagCategory, source?: string | null): string {
  const shown = cleanSource(source);
  if (category === 'ticket') return `Always tag sessions with ${shown ? `${shown} ` : ''}tickets`;
  return `Always tag sessions with ${category} tags`;
}

export interface RuleRow {
  key: string;
  label: string;
  value: RuleValue;
}

/** The stored rules for the Settings page. Derived, not ordered by the user: sorted by label. */
export function ruleRows(prefs: TagSuggestionPrefs): RuleRow[] {
  return Object.entries(prefs.rules)
    .flatMap(([key, rule]) => {
      const parsed = parseRuleKey(key);
      if (!parsed) return [];
      return [{ key, value: rule.value, label: kindLabel(parsed.category, rule.source ?? (parsed.source === ANY_SOURCE ? null : parsed.source)) }];
    })
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}
