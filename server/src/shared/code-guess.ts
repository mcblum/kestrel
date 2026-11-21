// The language of a code block that names none (Matt, 2026-11-19: pasted Swift "didn't
// highlight"). Prism has no detection of its own, so this reads the code for the marks each
// language leaves: a few weighted patterns per language, the best total wins, and too little
// evidence is no answer (the block stays plain, which is better than the wrong colours). Pure.
import { highlightLanguage, type HighlightLanguage } from './code-highlight.ts';

type Sign = readonly [pattern: RegExp, weight: number];

/** Evidence needed before a guess is made at all. */
const ENOUGH = 4;
/** Only the start of a long block is read. */
const SAMPLE_CHARS = 6_000;

const SCRIPT: readonly Sign[] = [
  [/\b(const|let|var) \w+ =/, 2],
  [/=>/, 2],
  [/\bimport [\s\S]{0,200}? from ['"]/, 3],
  [/\bexport (const|function|default|class|async)\b/, 3],
  [/\bawait\b/, 1],
];

// Order matters only for a tie: the earlier language wins.
const SIGNS: ReadonlyArray<readonly [HighlightLanguage, readonly Sign[]]> = [
  ['diff', [[/^diff --git /m, 5], [/^@@ -\d+/m, 5], [/^(---|\+\+\+) [ab]\//m, 3]]],
  ['php', [[/<\?php/, 6], [/\$\w+\s*=[^=]/, 2], [/\becho\b/, 1], [/->\w+\(/, 1]]],
  ['json', [[/^\s*[{[][\s\S]*[}\]]\s*$/, 2], [/^\s*"[^"\n]+"\s*:/m, 3], [/\b(const|let|var|function|import)\b/, -4]]],
  ['sql', [[/\b(SELECT\b[\s\S]*\bFROM|INSERT INTO|UPDATE \w+ SET|CREATE TABLE|ALTER TABLE|DELETE FROM)\b/i, 5], [/\b(WHERE|JOIN|GROUP BY|ORDER BY)\b/i, 1]]],
  ['bash', [
    [/^#!.*\b(ba|z)?sh\b/, 6],
    [/^\s*(sudo|cd|ls|echo|export|curl|git|npm|pnpm|brew|mkdir|rm|cat|grep|ssh|docker|kubectl|apt|chmod|source|set) \S/m, 3],
    [/\$\{?\w+\}?/, 1],
    [/\s\|\s/, 1],
    [/^\s*(if \[|fi$|done$|then$)/m, 3],
    [/ --?[a-z][\w-]*/, 1],
    [/[;{]\s*$/m, -2],
  ]],
  ['swift', [
    [/\bimport (SwiftUI|Foundation|UIKit|AppKit|Combine|XCTest)\b/, 5],
    [/@(State|Published|MainActor|objc|Binding|ObservedObject|Environment|Observable)\b/, 4],
    [/\bsome View\b/, 4],
    [/\bguard\b[^\n]*\belse\b/, 4],
    [/\bfunc \w+\s*[(<]/, 2],
    [/\\\(/, 3],
    [/\b\w+: (String|Int|Bool|Double|CGFloat|URL|Date|\[\w+\])\b/, 2],
    [/\b(struct|class|enum|extension|protocol) \w+\s*(:\s*[\w, ]+)?\s*\{/, 2],
    [/\b(if|while) let\b/, 2],
    [/\bcase \.\w+/, 3],
    [/\b(let|var) \w+(: [\w[\]?<>]+)? =/, 1],
    [/\bnil\b/, 1],
    [/->/, 1],
    [/;\s*$/m, -2],
  ]],
  ['go', [[/^package \w+/m, 4], [/\berr != nil\b/, 4], [/\bfmt\.\w+\(/, 3], [/^import \(/m, 3], [/\bfunc (\(\w+ \*?\w+\) )?\w+\(/, 2], [/:=/, 2], [/\bnil\b/, 1]]],
  ['rust', [[/\bfn \w+/, 3], [/\blet mut\b/, 4], [/\buse \w+::/, 4], [/\bimpl\b/, 3], [/\bpub (fn|struct|enum|mod)\b/, 3], [/\bprintln!/, 4], [/&str\b|&mut /, 3], [/->/, 1]]],
  ['kotlin', [[/\bfun \w+\(/, 4], [/\bval \w+/, 3], [/\bdata class\b/, 4], [/\bwhen \(/, 2], [/\bprintln\(/, 1]]],
  ['java', [[/^import java/m, 4], [/\bpublic (static )?(final )?(class|void|int|String)\b/, 4], [/\bSystem\.out\./, 4], [/@Override\b/, 3], [/\bprivate (final )?\w+ \w+;/, 3], [/\bnew \w+\(/, 1]]],
  ['cpp', [[/\bstd::/, 5], [/#include\s*<(iostream|vector|string|map|memory)>/, 6], [/\b(cout|cin) <<?/, 4], [/\btemplate\s*</, 3], [/\bint main\(/, 2]]],
  ['c', [[/#include\s*[<"]/, 5], [/\bprintf\(/, 3], [/\bint main\(/, 2], [/\b(malloc|sizeof)\(/, 2]]],
  ['python', [
    [/^\s*def \w+\(.*\).*:\s*$/m, 4],
    [/^\s*(if|for|while|elif|else|class|try|except|with)\b.*:\s*$/m, 3],
    [/^\s*(from \w[\w.]* )?import \w+/m, 2],
    [/__\w+__/, 3],
    [/\b(None|True|False)\b/, 2],
    [/\bself\b/, 1],
    [/\bprint\(/, 1],
    [/[;{]\s*$/m, -3],
  ]],
  ['ruby', [[/^\s*end\s*$/m, 3], [/\bdo \|\w+/, 4], [/\battr_(reader|accessor|writer)\b/, 4], [/\bputs\b/, 3], [/\brequire ['"]/, 3], [/^\s*def \w+/m, 2], [/[;{]\s*$/m, -3]]],
  ['javascript', [...SCRIPT, [/\bfunction\b/, 2], [/\bconsole\.\w+\(/, 3], [/\brequire\(/, 3], [/===/, 2]]],
  ['typescript', [
    ...SCRIPT,
    [/\binterface \w+ (extends [\w, ]+ )?\{/, 4],
    [/:\s*(string|number|boolean|unknown|void)\b/, 4],
    [/\btype \w+(<[^>]+>)? =/, 3],
    [/\bfunction\b/, 1],
    [/===/, 1],
  ]],
  ['css', [
    [/^\s*(color|margin|padding|display|font|background|border|width|height)[\w-]*\s*:[^;\n]+;/m, 3],
    [/^\s*[.#@:]?[\w-][^{};\n]*\{\s*$/m, 2],
    [/\d(px|rem|em|vh|vw|%)\b|#[0-9a-f]{3,6}\b/i, 1],
    [/\b(const|let|var|function|return|import)\b/, -4],
  ]],
  ['markup', [[/^\s*<(!DOCTYPE|\?xml|html|head|body|div|span|svg|p|a|ul|script|style)\b/im, 4], [/<\/\w+>/, 3], [/\b(const|import|function|return)\b/, -4]]],
  ['yaml', [
    [/^(apiVersion|kind|name|version|services|on|jobs|stages|metadata|spec):/m, 3],
    [/^[\w-]+:\s*$/m, 2],
    [/^\s{2,}[\w-]+: \S/m, 2],
    [/^---\s*$/m, 2],
    [/^\s*- [\w-]+: /m, 2],
    [/[;{}]\s*$/m, -3],
  ]],
];

const TAGS = /<\/\w+>|<\w+[^<>]*\/>/;
const WITH_TAGS: Partial<Record<HighlightLanguage, HighlightLanguage>> = { javascript: 'jsx', typescript: 'tsx' };

const score = (code: string, signs: readonly Sign[]): number => signs.reduce((total, [pattern, weight]) => (pattern.test(code) ? total + weight : total), 0);

/** The language `code` most reads as, or null when there is too little to tell. */
export function guessLanguage(code: string): HighlightLanguage | null {
  const sample = code.slice(0, SAMPLE_CHARS);
  if (!sample.trim()) return null;
  const best = SIGNS.reduce<{ language: HighlightLanguage | null; total: number }>(
    (top, [language, signs]) => {
      const total = score(sample, signs);
      return total > top.total ? { language, total } : top;
    },
    { language: null, total: ENOUGH - 1 },
  );
  if (!best.language) return null;
  return (TAGS.test(sample) && WITH_TAGS[best.language]) || best.language;
}

/** The grammar a block is drawn in: the one it names, or a guess when it names none. A name Kestrel does not know is plain. */
export function blockLanguage(lang: string | null | undefined, code: string): HighlightLanguage | null {
  return lang?.trim() ? highlightLanguage(lang) : guessLanguage(code);
}
