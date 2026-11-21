// What a new session's branch is called: the "Branch name prefix" setting (Settings → Git), checking
// a custom prefix, reading back what was stored, and putting the name together. Pure, shared with the
// UI (its live example uses `branchName`). The server resolves the prefix once per new worktree;
// existing branches are never renamed for a change of prefix (a late title may rename a new one: runtime/late-branch.ts).

/** `username`: the account gh (else glab) is signed in as. */
export const BRANCH_PREFIX_CHOICES = ['username', 'custom', 'kestrel', 'none'] as const;
export type BranchPrefixChoice = (typeof BRANCH_PREFIX_CHOICES)[number];
/** Choices saved by older versions, and what they are now: "GitHub username" became "Your username". */
const LEGACY_CHOICES: Readonly<Record<string, BranchPrefixChoice>> = { github: 'username' };

export interface BranchPrefixSetting {
  choice: BranchPrefixChoice;
  /** The text for "Custom", kept while another choice is picked so it is there when switched back. */
  custom: string;
}

/** Today's behaviour, and what anyone who never opens Settings keeps. */
export const DEFAULT_PREFIX = 'kestrel';
export const DEFAULT_BRANCH_PREFIX: BranchPrefixSetting = { choice: 'kestrel', custom: '' };
export const MAX_PREFIX_CHARS = 60;

const MAX_SLUG_CHARS = 32;
const SHORT_ID_CHARS = 8;
/** Characters git refuses in a ref name (git check-ref-format), whitespace and control characters. */
const BAD_CHARS = /[\s\x00-\x1f\x7f~^:?*[\\]/;

export const isBranchPrefixChoice = (value: unknown): value is BranchPrefixChoice => typeof value === 'string' && (BRANCH_PREFIX_CHOICES as readonly string[]).includes(value);

/** A stored or sent choice, an older name read as today's; null when it is none. */
export function readBranchPrefixChoice(value: unknown): BranchPrefixChoice | null {
  if (isBranchPrefixChoice(value)) return value;
  return typeof value === 'string' && Object.hasOwn(LEGACY_CHOICES, value) ? LEGACY_CHOICES[value]! : null;
}

/** Why `text` cannot be a branch name prefix (one or more path components), or null when it can. */
export function customPrefixProblem(text: string): string | null {
  if (!text) return 'Enter a prefix.';
  if (text.length > MAX_PREFIX_CHARS) return `Keep it under ${MAX_PREFIX_CHARS} characters.`;
  if (/\s/.test(text)) return 'No spaces.';
  if (BAD_CHARS.test(text)) return 'These characters are not allowed: ~ ^ : ? * [ \\';
  if (text.includes('..')) return 'No "..".';
  if (text.includes('@{') || text === '@') return 'No "@{".';
  if (text.startsWith('-')) return 'It cannot start with "-".';
  if (text.startsWith('/') || text.endsWith('/')) return 'It cannot start or end with "/".';
  if (text.includes('//')) return 'No empty parts ("//").';
  const parts = text.split('/');
  if (parts.some((p) => p.startsWith('.'))) return 'No part may start with ".".';
  if (parts.some((p) => p.endsWith('.lock'))) return 'No part may end with ".lock".';
  if (text.endsWith('.')) return 'It cannot end with ".".';
  return null;
}

/** What was stored, made safe: an unknown choice or an unusable custom prefix falls back to the default. */
export function sanitizeBranchPrefix(raw: unknown): BranchPrefixSetting {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_BRANCH_PREFIX;
  const value = raw as Record<string, unknown>;
  const custom = typeof value.custom === 'string' && customPrefixProblem(value.custom) === null ? value.custom : '';
  const choice = readBranchPrefixChoice(value.choice) ?? DEFAULT_BRANCH_PREFIX.choice;
  if (choice === 'custom' && !custom) return { choice: DEFAULT_BRANCH_PREFIX.choice, custom };
  return { choice, custom };
}

/**
 * The prefix a new branch gets: '' for None. "Your username" uses the signed-in account's name; with
 * none (gh and glab missing or signed out) it falls back to the default.
 */
export function resolvePrefix(setting: BranchPrefixSetting, username: string | null): string {
  if (setting.choice === 'none') return '';
  if (setting.choice === 'custom') return setting.custom || DEFAULT_PREFIX;
  if (setting.choice === 'username') return username && customPrefixProblem(username) === null ? username : DEFAULT_PREFIX;
  return DEFAULT_PREFIX;
}

/** A title as a branch-name word: lower case, dashes between words, up to 32 characters. */
export const branchSlug = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_SLUG_CHARS) || 'session';

/** The first 8 characters of a session id, without dashes: keeps two branches with one title apart. */
export const shortId = (sessionId: string): string => sessionId.replace(/-/g, '').slice(0, SHORT_ID_CHARS);

/** `<prefix>/<slug>-<short>`, or `<slug>-<short>` with no prefix. */
export function branchName(prefix: string, title: string, sessionId: string): string {
  const leaf = `${branchSlug(title)}-${shortId(sessionId)}`;
  return prefix ? `${prefix}/${leaf}` : leaf;
}
