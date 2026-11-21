// A code block's code with its syntax coloured: drawn plain first, coloured once its tokens are
// worked out (off the render, after the grammars have loaded), so nothing waits on the highlighter.
// Colour changes nothing but colour: the same characters in the same font and line height, so a
// row the transcript has measured keeps its height. A block still streaming in is tokenized at
// most every STREAM_THROTTLE_MS, and between runs the part already coloured stays coloured with the
// new tail plain after it.
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { blockLanguage } from '@kestrel/server/code-guess';
import { withinHighlightLimit, type CodeToken, type HighlightLanguage } from '@kestrel/server/code-highlight';
import { cachedTokens, tokensLater } from './highlighter.ts';
import '../styles/code-tokens.css';

/** The least time between two tokenizings of a block that keeps changing (one being streamed). */
const STREAM_THROTTLE_MS = 150;

interface Highlighted {
  language: HighlightLanguage;
  code: string;
  tokens: CodeToken[];
}

/** Tokens as spans with their role's class; text with no role stays a bare text node. */
function tokenNodes(tokens: readonly CodeToken[]): ReactNode[] {
  return tokens.map((token, i) =>
    token.role ? (
      <span key={i} className={`tok-${token.role}`}>
        {token.text}
      </span>
    ) : (
      token.text
    ),
  );
}

/** The newest tokens worked out for `code`, or null while there are none (or it is plain). */
function useHighlighted(language: HighlightLanguage | null, code: string): Highlighted | null {
  const eligible = language !== null && withinHighlightLimit(code);
  const [done, setDone] = useState<Highlighted | null>(() => {
    const held = eligible ? cachedTokens(language, code) : null;
    return held && language ? { language, code, tokens: held } : null;
  });
  const latest = useRef({ language, code });
  latest.current = { language, code };
  const timer = useRef<number | null>(null);
  const alive = useRef(true);
  useEffect(() => () => {
    alive.current = false;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => {
    alive.current = true;
    if (!eligible || (done && done.code === code && done.language === language)) return;
    // A run already waiting takes the newest code when it fires.
    if (timer.current !== null) return;
    const run = async () => {
      timer.current = null;
      const want = latest.current;
      if (!want.language) return;
      const tokens = await tokensLater(want.language, want.code);
      if (alive.current && tokens) setDone({ language: want.language, code: want.code, tokens });
    };
    timer.current = window.setTimeout(() => void run(), done ? STREAM_THROTTLE_MS : 0);
  }, [eligible, language, code, done]);
  return eligible && done?.language === language ? done : null;
}

/** The code of a block, coloured by the language it names, or the one it reads as when it names none; plain otherwise. */
export const HighlightedCode = memo(function HighlightedCode({ lang, code }: { lang: string | null; code: string }) {
  const language = useMemo(() => blockLanguage(lang, code), [lang, code]);
  const done = useHighlighted(language, code);
  const nodes = useMemo(() => {
    if (!done || !code.startsWith(done.code)) return code;
    const tail = code.slice(done.code.length);
    return tail ? [...tokenNodes(done.tokens), tail] : tokenNodes(done.tokens);
  }, [done, code]);
  return <code className={lang ? `language-${lang}` : undefined}>{nodes}</code>;
});
