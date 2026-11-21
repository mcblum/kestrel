// The lines of a file around one line, for showing where a review comment points. Pure.

export interface CodeExcerpt {
  /** The lines shown, joined by newlines. */
  code: string;
  /** The number of the first line shown, from 1. */
  first: number;
  /** Where the line asked for is among the lines shown, from 0; null when the file is shorter than that. */
  marked: number | null;
  /** How many lines the file has. */
  total: number;
}

/** How many lines are shown on each side of the line, until the whole file is asked for. */
export const EXCERPT_CONTEXT = 8;

/** `line` (from 1) with `context` lines on each side; the whole file when `context` is null. */
export function excerptAround(text: string, line: number, context: number | null = EXCERPT_CONTEXT): CodeExcerpt {
  const lines = text.replace(/\n$/, '').split('\n');
  const total = lines.length;
  const inFile = line >= 1 && line <= total;
  const from = context === null || !inFile ? 1 : Math.max(1, line - context);
  const to = context === null || !inFile ? total : Math.min(total, line + context);
  return { code: lines.slice(from - 1, to).join('\n'), first: from, marked: inFile ? line - from : null, total };
}

/** The file's extension, as a language hint for the highlighter; null when it has none. */
export function extensionOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : null;
}
