// The files Kestrel shows itself, in a sub-tab of the session, instead of handing them to another
// app: Markdown, rendered, and PDF. Pure and browser-safe: the server serves only these (and says
// why not for anything else), and the page offers Open only for these.

export type ViewableKind = 'markdown' | 'pdf';

const KIND_BY_EXTENSION: Readonly<Record<string, ViewableKind>> = { md: 'markdown', markdown: 'markdown', mdown: 'markdown', pdf: 'pdf' };

/** Content types the server sends each kind as. */
export const VIEWABLE_TYPE: Readonly<Record<ViewableKind, string>> = { markdown: 'text/markdown; charset=utf-8', pdf: 'application/pdf' };

/** The most of each kind that is read into the page. */
export const VIEWABLE_MAX_BYTES: Readonly<Record<ViewableKind, number>> = { markdown: 2 * 1024 * 1024, pdf: 100 * 1024 * 1024 };

/** What Kestrel can show of a file, by its name; null for a file it does not show. */
export function viewableKind(name: string): ViewableKind | null {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return KIND_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** The last part of a path, whichever way its separators lean. */
export const fileNameOf = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** Why a file of `kind` and `bytes` is not shown, or null when it is. */
export function tooLargeToView(kind: ViewableKind, bytes: number): string | null {
  const limit = VIEWABLE_MAX_BYTES[kind];
  return bytes > limit ? `This ${kind === 'pdf' ? 'PDF' : 'Markdown file'} is larger than ${Math.round(limit / 1024 / 1024)} MB, so it is not shown here.` : null;
}

/**
 * The path a piece of a message names, when it names a file Kestrel shows: the text of an inline
 * code span or the target of a link. `file://` and a trailing `:12` line number are taken off. Null
 * for a web address, for anything over one line, and for any other kind of file.
 */
export function viewablePathIn(text: string): string | null {
  let path = text.trim();
  if (!path || /[\n\r]/.test(path) || /^(https?|data|blob|mailto):/i.test(path) || path.startsWith('#')) return null;
  if (/^file:/i.test(path)) {
    try {
      path = decodeURIComponent(new URL(path).pathname);
    } catch {
      return null;
    }
  }
  path = path.replace(/(:\d+){1,2}$/, '');
  return viewableKind(fileNameOf(path)) && fileNameOf(path).lastIndexOf('.') > 0 ? path : null;
}
