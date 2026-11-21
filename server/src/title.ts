const TITLE_MAX = 70;
const CLEAN_MAX = 60;
const MAX_WORDS = 12;
const SHORT_WORDS = 4;

/** A one-line title from a prompt, summary or brief. */
export const titleFrom = (text: string): string => {
  const line = (text.trim().split('\n')[0] ?? '').trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
};

const words = (text: string): string[] => text.split(/\s+/).filter(Boolean);

/**
 * True when a generated title would add nothing: the prompt is one line and the title taken
 * from it is already a few words.
 */
export const titleIsEnough = (provisional: string, prompt: string): boolean =>
  !prompt.trim().includes('\n') && words(provisional).length <= SHORT_WORDS;

const WRAP = `\\s"'\`*_“”‘’`;
const LEADING_WRAP = new RegExp(`^[${WRAP}]+`);
const TRAILING_WRAP = new RegExp(`[${WRAP}]+$`);
const TRAILING_PUNCT = /[\s.,;:!?…-]+$/;
const LABEL = /^title\s*:\s*/i;
const REFUSAL = /^(i\s|i'm\s|sorry|as an ai|unfortunately)/i;

/** Quotes, backticks, markdown markers and a "Title:" label, peeled off both ends until none is left. */
function unwrap(line: string): string {
  let out = line;
  for (let prev = ''; prev !== out; ) {
    prev = out;
    out = out.replace(/^#+\s*/, '').replace(LABEL, '').replace(LEADING_WRAP, '').replace(TRAILING_WRAP, '').replace(TRAILING_PUNCT, '');
  }
  return out;
}

function capOnWord(text: string): string {
  if (text.length <= CLEAN_MAX) return text;
  const cut = text.slice(0, CLEAN_MAX + 1);
  const space = cut.lastIndexOf(' ');
  return space > 0 ? cut.slice(0, space) : text.slice(0, CLEAN_MAX);
}

/**
 * A model's reply made into a session title: the first non-empty line, without quotes,
 * markdown, a leading "Title:" or trailing punctuation, at most 60 characters on a word
 * boundary. Null when nothing usable is left, or the reply reads like a refusal or a sentence.
 */
export function cleanTitle(raw: string): string | null {
  const line = raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const text = unwrap(line).replace(/\s+/g, ' ').trim();
  if (!text || REFUSAL.test(text) || words(text).length > MAX_WORDS) return null;
  return unwrap(capOnWord(text)) || null;
}
