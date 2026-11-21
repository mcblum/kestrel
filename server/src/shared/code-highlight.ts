// Syntax highlighting of code, the parts that are not the highlighter (Matt, 2026-11-19: code blocks
// "formatted beautifully based on the language", as GitHub does). The highlighter is refractor
// (Prism's grammars, giving a hast tree); this module says which grammar a fence's language or a
// file's name means, how much code is highlighted at all, which of a few colour roles each Prism
// token type gets, and how a whole block's tokens fall onto its lines (the message box draws one
// element per line, while a block comment or a template string spans several). Pure.

/** The grammars Kestrel loads (refractor's names). Anything else is drawn plain. */
export const HIGHLIGHT_LANGUAGES = [
  'javascript',
  'jsx',
  'typescript',
  'tsx',
  'json',
  'bash',
  'python',
  'go',
  'rust',
  'swift',
  'kotlin',
  'java',
  'c',
  'cpp',
  'ruby',
  'php',
  'css',
  'scss',
  'markup',
  'markdown',
  'yaml',
  'toml',
  'sql',
  'diff',
  'docker',
  'hcl',
  'puppet',
] as const;

export type HighlightLanguage = (typeof HIGHLIGHT_LANGUAGES)[number];

/** Other names for a grammar, as written after a fence or as a file's extension. */
const ALIASES: Readonly<Record<string, HighlightLanguage>> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  node: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  jsonc: 'json',
  json5: 'json',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  py: 'python',
  python3: 'python',
  golang: 'go',
  rs: 'rust',
  kt: 'kotlin',
  kts: 'kotlin',
  h: 'c',
  'c++': 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  rb: 'ruby',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  xhtml: 'markup',
  plist: 'markup',
  md: 'markdown',
  yml: 'yaml',
  patch: 'diff',
  dockerfile: 'docker',
  terraform: 'hcl',
  tf: 'hcl',
  tfvars: 'hcl',
  pp: 'puppet',
};

const KNOWN = new Set<string>(HIGHLIGHT_LANGUAGES);

/** The grammar for a fence's language ("ts", "Python", "yml"), or null: unknown or none is plain. */
export function highlightLanguage(lang: string | null | undefined): HighlightLanguage | null {
  const name = lang?.trim().toLowerCase();
  if (!name) return null;
  if (KNOWN.has(name)) return name as HighlightLanguage;
  return ALIASES[name] ?? null;
}

/** Whole file names that say the language when the extension does not. */
const FILE_NAMES: Readonly<Record<string, HighlightLanguage>> = { dockerfile: 'docker', containerfile: 'docker', '.zshrc': 'bash', '.bashrc': 'bash', '.profile': 'bash' };

/** The grammar for a file by its name (a diff's path), or null. */
export function languageOfPath(path: string): HighlightLanguage | null {
  const name = (path.split('/').pop() ?? '').toLowerCase();
  if (FILE_NAMES[name]) return FILE_NAMES[name];
  if (name.startsWith('dockerfile.')) return 'docker';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? highlightLanguage(name.slice(dot + 1)) : null;
}

/**
 * Past this a block is drawn plain: thousands of lines are rarely read for their colours, and their
 * spans would cost more to lay out than they give. A diff has a lower line limit (`diffLines`, both
 * sides' lines counted together): each of its lines is a table row drawn again when colour arrives,
 * and at 3,000 lines working out the tokens alone took 40 to 100 ms.
 */
export const HIGHLIGHT_LIMIT = { chars: 120_000, lines: 3_000, diffLines: 1_500 } as const;

/** Whether `code` is small enough to highlight. */
export function withinHighlightLimit(code: string): boolean {
  if (code.length > HIGHLIGHT_LIMIT.chars) return false;
  let lines = 1;
  for (let i = code.indexOf('\n'); i !== -1; i = code.indexOf('\n', i + 1)) if (++lines > HIGHLIGHT_LIMIT.lines) return false;
  return true;
}

/**
 * The colour roles: few, so the code stays quiet in grey chrome. `inserted` and `deleted` are a
 * diff's own colours, for a ```diff block.
 */
export type TokenRole = 'comment' | 'string' | 'keyword' | 'constant' | 'name' | 'type' | 'punct' | 'inserted' | 'deleted';

/** Prism token types (and their aliases) by role. A type not listed has no colour of its own. */
const ROLE_TYPES: Readonly<Record<TokenRole, readonly string[]>> = {
  comment: ['comment', 'prolog', 'doctype', 'cdata', 'shebang'],
  string: ['string', 'char', 'regex', 'attr-value', 'url', 'template-string', 'code-snippet', 'heredoc-string'],
  keyword: ['keyword', 'atrule', 'rule', 'important', 'directive', 'macro', 'control-flow', 'title'],
  constant: ['number', 'boolean', 'constant', 'symbol', 'null', 'nil', 'entity', 'hexcode', 'unit'],
  name: ['function', 'function-variable', 'method', 'property', 'attr-name', 'variable', 'key'],
  type: ['class-name', 'tag', 'builtin', 'namespace', 'selector', 'decorator', 'annotation', 'maybe-class-name', 'generic'],
  punct: ['punctuation', 'operator'],
  inserted: ['inserted', 'inserted-sign'],
  deleted: ['deleted', 'deleted-sign'],
};

/** The order roles are tried in when a token carries several types (an alias as well as its own). */
const ROLE_ORDER: readonly TokenRole[] = ['inserted', 'deleted', 'comment', 'string', 'keyword', 'constant', 'type', 'name', 'punct'];

/** Types that end the search outward: what is inside an interpolation is code, not the string around it. */
const PLAIN_TYPES = new Set(['interpolation']);

const ROLE_OF_TYPE: ReadonlyMap<string, TokenRole> = new Map(ROLE_ORDER.flatMap((role) => ROLE_TYPES[role].map((type) => [type, role] as const)));

/** A token's role from its classes ("token", "keyword", ...); null for none, `plain` to stop looking outward. */
export function roleOf(classes: readonly string[]): TokenRole | null | 'plain' {
  let best: TokenRole | null = null;
  for (const name of classes) {
    const role = ROLE_OF_TYPE.get(name);
    if (role && (best === null || ROLE_ORDER.indexOf(role) < ROLE_ORDER.indexOf(best))) best = role;
  }
  if (best) return best;
  return classes.some((name) => PLAIN_TYPES.has(name)) ? 'plain' : null;
}

/** A piece of code and its colour role (null: drawn in the text colour). */
export interface CodeToken {
  text: string;
  role: TokenRole | null;
}

/** The part of a hast node (refractor's output) read here. */
export interface HastLike {
  type: string;
  value?: string;
  properties?: { className?: unknown };
  children?: readonly HastLike[];
}

const classesOf = (node: HastLike): string[] => {
  const names = node.properties?.className;
  return Array.isArray(names) ? names.map(String) : typeof names === 'string' ? names.split(/\s+/) : [];
};

/** The role of a text inside these elements, innermost first: the nearest one with a role wins. */
function roleWithin(path: readonly (TokenRole | null | 'plain')[]): TokenRole | null {
  for (let i = path.length - 1; i >= 0; i--) {
    const role = path[i]!;
    if (role === 'plain') return null;
    if (role) return role;
  }
  return null;
}

/** Add a token to the list being built, joined to the one before when it has the same role. */
function pushToken(out: CodeToken[], text: string, role: TokenRole | null): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.role === role) out[out.length - 1] = { text: last.text + text, role };
  else out.push({ text, role });
}

/** A highlighted tree as a flat run of tokens whose texts, joined, are the code exactly. */
export function flattenTokens(root: HastLike): CodeToken[] {
  const out: CodeToken[] = [];
  const walk = (node: HastLike, path: readonly (TokenRole | null | 'plain')[]): void => {
    if (node.type === 'text') return pushToken(out, node.value ?? '', roleWithin(path));
    const inner = node.type === 'element' ? [...path, roleOf(classesOf(node))] : path;
    for (const child of node.children ?? []) walk(child, inner);
  };
  walk(root, []);
  return out;
}

/** The tokens split at line breaks: one list per line (the break itself in neither), as many lines as the code has. */
export function tokenLines(tokens: readonly CodeToken[]): CodeToken[][] {
  const lines: CodeToken[][] = [[]];
  for (const token of tokens) {
    token.text.split('\n').forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1]!.push({ text: part, role: token.role });
    });
  }
  return lines;
}

/** A short key for how a line is coloured, so a line drawn with the same colours is left alone. */
export const lineSignature = (tokens: readonly CodeToken[]): string => tokens.map((t) => `${t.role ?? ''}${t.text.length}`).join(',');
