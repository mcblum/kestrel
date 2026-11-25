// A drawing of the What's new notes (`whats-new/images/<name>.svg`), made safe to put inline in the page
// (Matt, 2026-11-25: the spotlight's illustration comes from the release). Inline, so it can draw in
// `currentColor` and follow the page's blue in light and dark; an <img> could not.
//
// It is an allow-list, not a cleaner: the file is read as a sequence of tags and text, and the markup is
// written again from scratch with only the elements and attributes below. Anything else is left out with
// everything inside it: scripts, styles, event attributes, links (`href`, `xlink:href`), `use`, `image`,
// `foreignObject`, any `url(…)` reference. A file that cannot be read as plain SVG gives null. The files
// are ours, and it still holds them to this. Dependency-free and pure: the server serves its answer and
// the page runs it again just before drawing.

/** The name of a drawing beside the notes: a plain file name ending in .svg. */
export const NOTES_DRAWING = /^[a-z0-9][a-z0-9._-]{0,80}\.svg$/i;

const SHAPES = ['g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon'] as const;
const ELEMENTS: ReadonlySet<string> = new Set(['svg', ...SHAPES, 'title', 'desc']);
/** Elements whose text is kept (escaped); text anywhere else is only whitespace and is dropped. */
const TEXT_ELEMENTS: ReadonlySet<string> = new Set(['title', 'desc']);

const PAINT = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit', 'opacity', 'fill-opacity', 'stroke-opacity', 'fill-rule', 'clip-rule', 'vector-effect', 'transform', 'class'];
const GEOMETRY = ['d', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'width', 'height', 'x1', 'y1', 'x2', 'y2', 'points', 'pathLength'];
const ATTRIBUTES: ReadonlySet<string> = new Set([...PAINT, ...GEOMETRY, 'viewBox', 'preserveAspectRatio', 'role', 'aria-hidden', 'aria-label', 'xmlns']);
const SVG_NS = 'http://www.w3.org/2000/svg';

/** A value that could reach outside the drawing or run something. */
const UNSAFE_VALUE = /url\s*\(|javascript:|data:|expression\s*\(|[<>]/i;

const NAME = '[A-Za-z][A-Za-z0-9:._-]*';
const ATTR = new RegExp(`\\s+(${NAME})\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'y');
const OPEN = new RegExp(`<(${NAME})`, 'y');

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (text: string): string | null => {
  let bad = false;
  const out = text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);?/gi, (_, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    const v = ENTITIES[e.toLowerCase()];
    if (v === undefined) bad = true;
    return v ?? '';
  });
  return bad ? null : out;
};
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

type Token = { kind: 'open'; name: string; attrs: [string, string][]; selfClosing: boolean } | { kind: 'close'; name: string } | { kind: 'text'; text: string };

/** The file as tags and text; null when it holds anything else (a doctype, a CDATA section, a stray `<`). */
function tokens(source: string): Token[] | null {
  const out: Token[] = [];
  let at = 0;
  const text = source.replace(/^﻿/, '').replace(/^\s*<\?xml[^?]*\?>/, '');
  while (at < text.length) {
    const lt = text.indexOf('<', at);
    if (lt < 0 || lt > at) {
      const raw = text.slice(at, lt < 0 ? text.length : lt);
      const decoded = decode(raw);
      if (decoded === null) return null;
      out.push({ kind: 'text', text: decoded });
      if (lt < 0) break;
    }
    at = lt;
    if (text.startsWith('<!--', at)) {
      const end = text.indexOf('-->', at + 4);
      if (end < 0) return null;
      at = end + 3;
      continue;
    }
    if (text.startsWith('</', at)) {
      const m = new RegExp(`</(${NAME})\\s*>`, 'y');
      m.lastIndex = at;
      const close = m.exec(text);
      if (!close) return null;
      out.push({ kind: 'close', name: close[1]! });
      at = m.lastIndex;
      continue;
    }
    OPEN.lastIndex = at;
    const open = OPEN.exec(text);
    if (!open) return null;
    at = OPEN.lastIndex;
    const attrs: [string, string][] = [];
    for (;;) {
      ATTR.lastIndex = at;
      const a = ATTR.exec(text);
      if (!a) break;
      const value = decode(a[2] ?? a[3] ?? '');
      if (value === null) return null;
      attrs.push([a[1]!, value]);
      at = ATTR.lastIndex;
    }
    const end = /\s*(\/?)>/y;
    end.lastIndex = at;
    const closed = end.exec(text);
    if (!closed) return null;
    at = end.lastIndex;
    out.push({ kind: 'open', name: open[1]!, attrs, selfClosing: closed[1] === '/' });
  }
  return out;
}

const keptAttrs = (name: string, attrs: readonly [string, string][]): string =>
  attrs
    .filter(([key, value]) => ATTRIBUTES.has(key) && !UNSAFE_VALUE.test(value) && (key !== 'xmlns' || (name === 'svg' && value === SVG_NS)))
    .map(([key, value]) => ` ${key}="${escape(value)}"`)
    .join('');

/**
 * The drawing as markup that is safe to put in the page, or null when the file is not a plain SVG
 * drawing: it must be one <svg> element, every tag closed in order.
 */
export function sanitizeSvg(source: string): string | null {
  const list = tokens(source);
  if (!list) return null;
  const stack: string[] = [];
  /** How deep inside a left-out element the reader is; nothing is written while it is above 0. */
  let skipping = 0;
  let out = '';
  let roots = 0;
  for (const t of list) {
    if (t.kind === 'text') {
      if (skipping === 0 && TEXT_ELEMENTS.has(stack.at(-1) ?? '')) out += escape(t.text);
      else if (stack.length === 0 && t.text.trim() !== '') return null;
      continue;
    }
    if (t.kind === 'open') {
      if (stack.length === 0 && ++roots > 1) return null;
      if (stack.length === 0 && t.name !== 'svg') return null;
      const kept = skipping === 0 && ELEMENTS.has(t.name) && !(t.name === 'svg' && stack.length > 0);
      if (!kept && !t.selfClosing) skipping++;
      if (t.selfClosing) {
        if (kept) out += `<${t.name}${keptAttrs(t.name, t.attrs)}/>`;
        if (stack.length === 0) return null;
        continue;
      }
      stack.push(t.name);
      if (kept) out += `<${t.name}${keptAttrs(t.name, t.attrs)}>`;
      continue;
    }
    if (stack.at(-1) !== t.name) return null;
    stack.pop();
    if (skipping > 0) skipping--;
    else out += `</${t.name}>`;
  }
  return stack.length === 0 && roots === 1 ? out : null;
}
