// The highlighter as the app uses it: refractor's grammars loaded once, on first need, in a chunk of
// their own (grammars.ts), and each block's tokens kept by (language, code), so a row scrolled back
// into view, a remount, or the same block in two places is not tokenized again. The tokens are
// derived from code already on the page, not server data: a bounded cache of drawing work.
import { flattenTokens, withinHighlightLimit, type CodeToken, type HighlightLanguage } from '@kestrel/server/code-highlight';

type Grammars = typeof import('./grammars.ts');

/** How many blocks' tokens are kept; the oldest goes first. */
const CACHE_BLOCKS = 400;

let grammars: Grammars | null = null;
let loading: Promise<Grammars> | null = null;
const cache = new Map<string, CodeToken[]>();

const keyOf = (language: HighlightLanguage, code: string) => `${language}\u0000${code}`;

/** The grammars, loaded once. A failed load is tried again next time. */
export function loadGrammars(): Promise<Grammars> {
  if (grammars) return Promise.resolve(grammars);
  loading ??= import('./grammars.ts').then(
    (loaded) => (grammars = loaded),
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

/** The grammars when they are already here (for a diff's tokenize), else null. */
export const loadedGrammars = (): Grammars | null => grammars;

/** Tokens already worked out for this code, or null. */
export function cachedTokens(language: HighlightLanguage, code: string): CodeToken[] | null {
  return cache.get(keyOf(language, code)) ?? null;
}

/**
 * `code`'s tokens, now, when the grammars are loaded; null when they are not or the code is past
 * the limit (drawn plain). A highlighter that throws on odd input leaves the code plain too.
 */
export function tokensNow(language: HighlightLanguage, code: string): CodeToken[] | null {
  if (!grammars || !withinHighlightLimit(code)) return null;
  const key = keyOf(language, code);
  const held = cache.get(key);
  if (held) {
    cache.delete(key);
    cache.set(key, held);
    return held;
  }
  let tokens: CodeToken[];
  try {
    tokens = flattenTokens(grammars.highlightTree(code, language));
  } catch {
    return null;
  }
  cache.set(key, tokens);
  if (cache.size > CACHE_BLOCKS) cache.delete(cache.keys().next().value!);
  return tokens;
}

/** `code`'s tokens once the grammars are loaded (null: plain). */
export async function tokensLater(language: HighlightLanguage, code: string): Promise<CodeToken[] | null> {
  if (!grammars) await loadGrammars();
  return tokensNow(language, code);
}
